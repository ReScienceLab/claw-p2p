package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/ReScienceLab/DeClaw/rooms/games/mahjong/game"
	"github.com/ReScienceLab/DeClaw/rooms/sdk"
)

// ── Stub server (no-op, all WaitForAction return nil immediately) ─────────────

type stubServer struct{}

func (s *stubServer) Send(_ string, _ any) error { return nil }
func (s *stubServer) Broadcast(_ any)            {}
func (s *stubServer) BroadcastWS(_ any)          {}
func (s *stubServer) WaitForAction(_ string, _ time.Duration) json.RawMessage {
	return nil // triggers auto-timeout path in the room
}
func (s *stubServer) Participants() map[string]*sdk.ParticipantRecord {
	m := make(map[string]*sdk.ParticipantRecord)
	for _, seat := range seats {
		m[seat] = &sdk.ParticipantRecord{Name: seat + "-bot", IsBot: true}
	}
	return m
}
func (s *stubServer) SeatOf(_ string) string { return "" }

// ── StateMachine test (no network) ───────────────────────────────────────────

func TestMahjongRoom_StateMachine(t *testing.T) {
	room := newMahjongRoom()
	room.srv = &stubServer{}

	// Trigger game start (replaces lobby)
	if err := room.OnLobbyComplete(); err != nil {
		t.Fatalf("OnLobbyComplete: %v", err)
	}
	time.Sleep(150 * time.Millisecond)

	room.mu.Lock()
	state := room.state
	wallLen := len(room.wall)
	room.mu.Unlock()

	t.Logf("After start — state=%s wall=%d", state, wallLen)

	if state != "DRAW" && state != "CLAIM" && state != "GAMEOVER" {
		t.Errorf("expected game running state, got %s", state)
	}

	// Each player should have ≥13 tiles
	room.mu.Lock()
	for _, s := range seats {
		h := len(room.hands[s])
		t.Logf("  %s: %d tiles", s, h)
		if h < 13 {
			t.Errorf("%s has only %d tiles", s, h)
		}
	}
	dora := room.doraIndicator
	room.mu.Unlock()

	if dora == "" {
		t.Error("dora indicator not set")
	}
	t.Logf("Dora indicator: %s", dora)

	// Simulate turn: current player discards
	room.mu.Lock()
	currentSeat := seats[room.turnIndex%4]
	hand := make([]string, len(room.hands[currentSeat]))
	copy(hand, room.hands[currentSeat])
	room.mu.Unlock()

	if len(hand) == 0 {
		t.Fatal("current player has empty hand")
	}

	discard := hand[0]
	t.Logf("Simulating %s discards %s", currentSeat, discard)
	actionJSON, _ := json.Marshal(map[string]any{"action": "discard", "tile": discard})
	if err := room.OnAction(currentSeat, json.RawMessage(actionJSON)); err != nil {
		t.Errorf("OnAction: %v", err)
	}

	// Wait for claim window to open/close
	time.Sleep(200 * time.Millisecond)
	room.mu.Lock()
	newState := room.state
	room.mu.Unlock()
	t.Logf("State after discard: %s", newState)

	// Claim window (8s timeout) or already moved to next DRAW
	if newState != "CLAIM" && newState != "DRAW" && newState != "GAMEOVER" {
		t.Errorf("unexpected state after discard: %s", newState)
	}
}

// ── Wall exhaustion test ──────────────────────────────────────────────────────

func TestMahjongRoom_Exhaustion(t *testing.T) {
	room := newMahjongRoom()
	room.srv = &stubServer{}

	if err := room.OnLobbyComplete(); err != nil {
		t.Fatalf("OnLobbyComplete: %v", err)
	}
	time.Sleep(150 * time.Millisecond)

	// Drain wall by sending discards until gameover or timeout
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		room.mu.Lock()
		state := room.state
		currentSeat := seats[room.turnIndex%4]
		hand := room.hands[currentSeat]
		room.mu.Unlock()

		if state == "GAMEOVER" {
			t.Log("Game ended (gameover)")
			break
		}
		if state == "DRAW" && len(hand) > 0 {
			discard := hand[0]
			actionJSON, _ := json.Marshal(map[string]any{"action": "discard", "tile": discard})
			_ = room.OnAction(currentSeat, json.RawMessage(actionJSON))
			time.Sleep(50 * time.Millisecond)
		} else {
			time.Sleep(50 * time.Millisecond)
		}
	}

	room.mu.Lock()
	finalState := room.state
	room.mu.Unlock()
	t.Logf("Final state: %s", finalState)
	// Game should have ended (exhausted wall) or still running — just verify no panic
}

// ── Score calculation sanity test ─────────────────────────────────────────────

func TestMahjongRoom_ScoreSanity(t *testing.T) {
	// Verify scoring is deterministic across multiple runs
	hands := []struct {
		hand []string
		win  string
		want string
	}{
		{
			hand: []string{"1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m", "1p", "2p", "3p", "5p", "5p"},
			win:  "5p", want: "平胡",
		},
		{
			hand: []string{"1m", "1m", "2p", "2p", "3s", "3s", "4m", "4m", "5p", "5p", "6s", "6s", "1z", "1z"},
			win:  "1z", want: "七对子",
		},
	}
	for _, tc := range hands {
		res := game.CalculateFan(tc.hand, nil, tc.win, game.ScoringCtx{
			IsTsumo: false, Seat: "east", RoundWind: "east",
		})
		if res.Points < 8 {
			t.Errorf("hand %v: points=%d < 8 minimum", tc.hand[:4], res.Points)
		}
		found := false
		for _, y := range res.Yaku {
			if y == tc.want {
				found = true
			}
		}
		if !found {
			t.Errorf("hand %v: expected yaku %q, got %v", tc.hand[:4], tc.want, res.Yaku)
		}
		t.Logf("hand type=%s → %dpt %v", tc.want, res.Points, res.Yaku)
	}
}

// ── HTTP integration test (starts real peer server in testMode) ────────────────

func TestMahjongRoom_HTTP(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping HTTP integration test in short mode")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	t.Setenv("YGGDRASIL_ADDR", "::1")

	// Locate the dashboard static dir relative to this test file
	_, testFile, _, _ := runtime.Caller(0)
	dashDir := filepath.Join(filepath.Dir(testFile), "dashboard")

	p2pPort := 19099
	dashPort := 19080

	room := newMahjongRoom()
	srv := sdk.NewServer(sdk.ServerConfig{
		Room:          room,
		Name:          "Test Room",
		Slots:         4,
		Port:          p2pPort,
		DashPort:      dashPort,
		DataDir:       t.TempDir(),
		YggMode:       sdk.YggModeEnvAddr,
		TestMode:      true,
		DashStaticDir: dashDir,
	})
	room.srv = srv

	go func() { _ = srv.Start(ctx) }()

	// Wait for HTTP server
	pingURL := fmt.Sprintf("http://127.0.0.1:%d/peer/ping", p2pPort)
	ready := false
	for i := 0; i < 50; i++ {
		resp, err := http.Get(pingURL)
		if err == nil && resp.StatusCode == 200 {
			resp.Body.Close()
			ready = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !ready {
		t.Fatal("peer server did not start within 5s")
	}
	t.Log("Peer server ready")

	// Check dashboard
	dashURL := fmt.Sprintf("http://127.0.0.1:%d/", dashPort)
	resp, err := http.Get(dashURL)
	if err != nil {
		t.Fatalf("dashboard GET: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("dashboard: expected 200, got %d", resp.StatusCode)
	}
	t.Logf("Dashboard OK: %d", resp.StatusCode)

	// Send 4 join messages from distinct fake addresses
	for i := 1; i <= 4; i++ {
		fakeAddr := fmt.Sprintf("::%.4x", i)
		fakePub := fmt.Sprintf("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%d=", i)
		payload := fmt.Sprintf(`{"type":"room:join","name":"Bot%d"}`, i)
		body, _ := json.Marshal(map[string]any{
			"fromYgg":   fakeAddr,
			"publicKey": fakePub,
			"event":     "room:join",
			"content":   payload,
			"timestamp": time.Now().UnixMilli(),
			"signature": "test",
		})
		resp, err := http.Post(
			fmt.Sprintf("http://127.0.0.1:%d/peer/message", p2pPort),
			"application/json",
			bytes.NewReader(body),
		)
		if err != nil {
			t.Fatalf("join Bot%d: %v", i, err)
		}
		resp.Body.Close()
		t.Logf("Bot%d joined (addr=%s)", i, fakeAddr)
		time.Sleep(50 * time.Millisecond)
	}

	// Wait for game to start (lobby full → OnLobbyComplete)
	deadline2 := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline2) {
		room.mu.Lock()
		state := room.state
		room.mu.Unlock()
		if state != "LOBBY" && state != "DEALING" {
			t.Logf("Game started! State=%s", state)
			break
		}
		time.Sleep(100 * time.Millisecond)
	}

	room.mu.Lock()
	finalState := room.state
	wallLen := len(room.wall)
	dora := room.doraIndicator
	hands := make(map[string]int)
	for _, s := range seats {
		hands[s] = len(room.hands[s])
	}
	room.mu.Unlock()

	t.Logf("State=%s wall=%d dora=%s", finalState, wallLen, dora)
	for s, h := range hands {
		t.Logf("  %s: %d tiles", s, h)
	}

	if finalState == "LOBBY" || finalState == "DEALING" {
		t.Errorf("Game did not start after 4 players joined (state=%s)", finalState)
	}

	cancel()
}
