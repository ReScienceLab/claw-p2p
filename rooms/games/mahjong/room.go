package main

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/ReScienceLab/DeClaw/rooms/games/mahjong/game"
	"github.com/ReScienceLab/DeClaw/rooms/sdk"
)

const (
	claimTimeout = 8 * time.Second
	turnTimeout  = 15 * time.Second
)

var seats = []string{"east", "south", "west", "north"}

// GameServer is the subset of sdk.Server that MahjongRoom uses.
// Defined as an interface to allow test stubs.
type GameServer interface {
	Send(seat string, event any) error
	Broadcast(event any)
	BroadcastWS(event any)
	WaitForAction(seat string, timeout time.Duration) json.RawMessage
	Participants() map[string]*sdk.ParticipantRecord
	SeatOf(yggAddr string) string
}

// MahjongRoom implements sdk.Room for Chinese standard mahjong.
type MahjongRoom struct {
	srv GameServer

	mu            sync.Mutex
	state         string // LOBBY | DEALING | DRAW | CLAIM | GAMEOVER
	wall          []string
	hands         map[string][]string
	melds         map[string][]game.Meld
	discards      map[string][]string
	scores        map[string]int
	turnIndex     int
	round         int
	doraIndicator string
	gameCount     int

	// claim window: seat → result channel
	pendingClaims map[string]chan claimResult
}

type claimResult struct {
	seat   string
	action claimAction
}

type claimAction struct {
	Action string   `json:"action"`
	Use    []string `json:"use,omitempty"`
}

type discardAction struct {
	Action string `json:"action"`
	Tile   string `json:"tile"`
}

func newMahjongRoom() *MahjongRoom {
	r := &MahjongRoom{
		state:         "LOBBY",
		hands:         make(map[string][]string),
		melds:         make(map[string][]game.Meld),
		discards:      make(map[string][]string),
		scores:        map[string]int{"east": 25000, "south": 25000, "west": 25000, "north": 25000},
		round:         1,
		pendingClaims: make(map[string]chan claimResult),
	}
	for _, s := range seats {
		r.hands[s] = nil
		r.melds[s] = nil
		r.discards[s] = nil
	}
	return r
}

// ── sdk.Room interface ────────────────────────────────────────────────────────

func (r *MahjongRoom) OnParticipantJoin(seat string, info sdk.ParticipantInfo) error {
	log.Printf("[mahjong] %s joined as %s", info.Name, seat)
	r.srv.BroadcastWS(map[string]any{
		"event": "lobby",
		"data":  r.lobbyState(),
	})
	return nil
}

func (r *MahjongRoom) OnAction(seat string, raw json.RawMessage) error {
	r.mu.Lock()
	state := r.state
	r.mu.Unlock()

	switch state {
	case "DRAW":
		var da discardAction
		if err := json.Unmarshal(raw, &da); err != nil {
			return nil
		}
		if da.Action == "discard" {
			go r.handleDiscard(seat, da.Tile)
		} else if da.Action == "hu" {
			go r.handleTsumo(seat)
		} else if da.Action == "gang" {
			go r.handleGang(seat, da.Tile, "closed")
		}
	case "CLAIM":
		var ca claimAction
		if err := json.Unmarshal(raw, &ca); err != nil {
			return nil
		}
		r.mu.Lock()
		ch := r.pendingClaims[seat]
		r.mu.Unlock()
		if ch != nil {
			select {
			case ch <- claimResult{seat: seat, action: ca}:
			default:
			}
		}
	}
	return nil
}

func (r *MahjongRoom) OnParticipantLeave(seat string) error {
	log.Printf("[mahjong] %s left", seat)
	return nil
}

func (r *MahjongRoom) GetInitialState() any {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.publicState()
}

func (r *MahjongRoom) GetRoomMeta() sdk.RoomMeta {
	return sdk.RoomMeta{Type: "mahjong", Slots: 4}
}

func (r *MahjongRoom) OnLobbyComplete() error {
	return r.startNewGame()
}

// ── Game flow ─────────────────────────────────────────────────────────────────

func (r *MahjongRoom) startNewGame() error {
	r.mu.Lock()
	r.gameCount++
	r.state = "DEALING"
	wall := game.CreateWall()
	game.Shuffle(wall)
	for _, s := range seats {
		r.hands[s] = wall[:13]
		wall = wall[13:]
		r.melds[s] = nil
		r.discards[s] = nil
	}
	r.doraIndicator = wall[0]
	wall = wall[1:]
	r.wall = wall
	r.turnIndex = 0
	r.mu.Unlock()

	log.Printf("[mahjong] Game #%d started — wall: %d tiles", r.gameCount, len(wall))

	for _, s := range seats {
		r.mu.Lock()
		hand := game.SortTiles(r.hands[s])
		dora := r.doraIndicator
		r.mu.Unlock()
		_ = r.srv.Send(s, map[string]any{
			"type":          "game:deal",
			"hand":          hand,
			"doraIndicator": dora,
		})
	}
	r.broadcastState()
	return r.nextTurn()
}

func (r *MahjongRoom) nextTurn() error {
	r.mu.Lock()
	if len(r.wall) == 0 {
		r.mu.Unlock()
		return r.handleExhausted()
	}
	r.state = "DRAW"
	seat := seats[r.turnIndex%4]
	tile := game.DrawFromFront(&r.wall)
	r.hands[seat] = append(r.hands[seat], tile)
	r.mu.Unlock()

	log.Printf("[mahjong] %s draws — wall: %d", seat, len(r.wall))

	_ = r.srv.Send(seat, map[string]any{
		"type":     "game:draw",
		"tile":     tile,
		"hand":     game.SortTiles(r.hands[seat]),
		"wallSize": len(r.wall),
	})
	r.srv.BroadcastWS(map[string]any{"event": "move", "data": map[string]any{
		"seat": seat, "action": "draw", "wallSize": len(r.wall),
	}})
	r.srv.BroadcastWS(map[string]any{"event": "thinking", "data": map[string]any{"seat": seat}})

	// Auto-timeout: if no action in turnTimeout, discard first tile
	go func() {
		action := r.srv.WaitForAction(seat, turnTimeout)
		if action == nil {
			log.Printf("[mahjong] %s timeout — auto-discard", seat)
			r.mu.Lock()
			hand := r.hands[seat]
			r.mu.Unlock()
			if len(hand) > 0 {
				da := discardAction{Action: "discard", Tile: game.SortTiles(hand)[0]}
				b, _ := json.Marshal(da)
				_ = r.OnAction(seat, b)
			}
		}
	}()
	return nil
}

func (r *MahjongRoom) handleDiscard(seat, tile string) {
	r.mu.Lock()
	if seats[r.turnIndex%4] != seat {
		r.mu.Unlock()
		return
	}
	// Validate tile in hand
	if !contains(r.hands[seat], tile) {
		tile = game.SortTiles(r.hands[seat])[0]
	}
	r.hands[seat] = game.RemoveTile(r.hands[seat], tile)
	r.discards[seat] = append(r.discards[seat], tile)
	r.mu.Unlock()

	log.Printf("[mahjong] %s discards %s", seat, tile)
	r.srv.Broadcast(map[string]any{"type": "game:discard_event", "seat": seat, "tile": tile})
	r.srv.BroadcastWS(map[string]any{"event": "move", "data": map[string]any{"seat": seat, "action": "discard", "tile": tile}})
	r.broadcastState()

	winner := r.openClaimWindow(tile, seat)
	if winner != "" {
		return
	}

	r.mu.Lock()
	r.turnIndex++
	r.mu.Unlock()
	_ = r.nextTurn()
}

func (r *MahjongRoom) handleTsumo(seat string) {
	r.mu.Lock()
	if seats[r.turnIndex%4] != seat {
		r.mu.Unlock()
		return
	}
	hand := r.hands[seat]
	melds := r.melds[seat]
	r.mu.Unlock()

	if !game.CanHu(hand, melds, "") {
		log.Printf("[mahjong] %s invalid tsumo", seat)
		return
	}
	winTile := hand[len(hand)-1]
	res := game.CalculateFan(hand, melds, winTile, game.ScoringCtx{IsTsumo: true, Seat: seat, RoundWind: "east"})
	log.Printf("[mahjong] %s wins by tsumo! %dpt %v", seat, res.Points, res.Yaku)
	r.updateScores(seat, res.Points, "")
	r.endGame(seat, winTile, res, true)
}

func (r *MahjongRoom) handleGang(seat, tile, gangType string) {
	r.mu.Lock()
	hand := r.hands[seat]
	if !contains(hand, tile) {
		r.mu.Unlock()
		return
	}
	n := 4
	if gangType == "open" {
		n = 3
	}
	h := hand
	for i := 0; i < n; i++ {
		h = game.RemoveTile(h, tile)
	}
	r.hands[seat] = h
	r.melds[seat] = append(r.melds[seat], game.Meld{Type: "gang", Tiles: []string{tile, tile, tile, tile}, GangType: gangType})
	supplement := game.DrawFromBack(&r.wall)
	if supplement == "" {
		r.mu.Unlock()
		_ = r.handleExhausted()
		return
	}
	r.hands[seat] = append(r.hands[seat], supplement)
	r.mu.Unlock()

	r.srv.Broadcast(map[string]any{"type": "game:meld", "seat": seat, "meldType": "gang", "tiles": []string{tile, tile, tile, tile}})
	_ = r.srv.Send(seat, map[string]any{"type": "game:gang_supplement", "tile": supplement, "hand": game.SortTiles(r.hands[seat])})
	r.broadcastState()
	r.srv.BroadcastWS(map[string]any{"event": "thinking", "data": map[string]any{"seat": seat}})

	// Re-enter draw phase — same seat must discard
	go func() {
		action := r.srv.WaitForAction(seat, turnTimeout)
		if action == nil {
			r.mu.Lock()
			hand := r.hands[seat]
			r.mu.Unlock()
			if len(hand) > 0 {
				da := discardAction{Action: "discard", Tile: game.SortTiles(hand)[0]}
				b, _ := json.Marshal(da)
				_ = r.OnAction(seat, b)
			}
		}
	}()
}

func (r *MahjongRoom) openClaimWindow(tile, fromSeat string) string {
	r.mu.Lock()
	r.state = "CLAIM"
	r.mu.Unlock()

	type eligResult struct {
		seat    string
		actions []string
	}
	var eligible []eligResult
	for _, s := range seats {
		if s == fromSeat {
			continue
		}
		r.mu.Lock()
		hand := r.hands[s]
		melds := r.melds[s]
		r.mu.Unlock()
		available := r.availableActions(s, hand, melds, tile, fromSeat)
		eligible = append(eligible, eligResult{s, available})
	}

	// If no one can do anything, skip
	anyNonPass := false
	for _, e := range eligible {
		for _, a := range e.actions {
			if a != "pass" {
				anyNonPass = true
			}
		}
	}
	if !anyNonPass {
		r.mu.Lock()
		r.state = "DRAW"
		r.mu.Unlock()
		return ""
	}

	// Open claim channels
	results := make([]claimResult, 0, len(eligible))
	var wg sync.WaitGroup
	var resMu sync.Mutex

	for _, e := range eligible {
		wg.Add(1)
		go func(s string, available []string) {
			defer wg.Done()
			var res claimResult
			hasNonPass := false
			for _, a := range available {
				if a != "pass" {
					hasNonPass = true
				}
			}
			if !hasNonPass {
				res = claimResult{seat: s, action: claimAction{Action: "pass"}}
			} else {
				ch := make(chan claimResult, 1)
				r.mu.Lock()
				r.pendingClaims[s] = ch
				r.mu.Unlock()
				_ = r.srv.Send(s, map[string]any{
					"type":       "game:claim_window",
					"tile":       tile,
					"from":       fromSeat,
					"available":  available,
					"deadlineMs": claimTimeout.Milliseconds(),
				})
				r.srv.BroadcastWS(map[string]any{"event": "thinking", "data": map[string]any{"seat": s}})
				select {
				case res = <-ch:
				case <-time.After(claimTimeout):
					res = claimResult{seat: s, action: claimAction{Action: "pass"}}
				}
				r.mu.Lock()
				delete(r.pendingClaims, s)
				r.mu.Unlock()
			}
			resMu.Lock()
			results = append(results, res)
			resMu.Unlock()
		}(e.seat, e.actions)
	}
	wg.Wait()

	r.mu.Lock()
	r.state = "DRAW"
	r.mu.Unlock()

	return r.resolveClaims(results, tile, fromSeat)
}

func (r *MahjongRoom) resolveClaims(results []claimResult, tile, fromSeat string) string {
	priority := map[string]int{"hu": 4, "gang": 3, "peng": 2, "chi": 1, "pass": 0}
	best := claimResult{action: claimAction{Action: "pass"}}
	for _, res := range results {
		if priority[res.action.Action] > priority[best.action.Action] {
			best = res
		}
	}
	if best.action.Action == "pass" {
		return ""
	}

	seat := best.seat
	action := best.action
	log.Printf("[mahjong] %s claims %s on %s", seat, action.Action, tile)

	switch action.Action {
	case "hu":
		r.mu.Lock()
		hand := append(r.hands[seat], tile)
		melds := r.melds[seat]
		r.mu.Unlock()
		res := game.CalculateFan(hand, melds, tile, game.ScoringCtx{IsTsumo: false, Seat: seat, RoundWind: "east"})
		log.Printf("[mahjong] %s wins by ron! %dpt %v", seat, res.Points, res.Yaku)
		r.mu.Lock()
		r.hands[seat] = hand
		r.mu.Unlock()
		r.updateScores(seat, res.Points, fromSeat)
		r.endGame(seat, tile, res, false)
		return seat

	case "peng":
		r.mu.Lock()
		h := game.RemoveTile(game.RemoveTile(r.hands[seat], tile), tile)
		r.hands[seat] = h
		r.melds[seat] = append(r.melds[seat], game.Meld{Type: "peng", Tiles: []string{tile, tile, tile}, FromSeat: fromSeat})
		r.turnIndex = indexOf(seats, seat)
		r.mu.Unlock()
		r.srv.Broadcast(map[string]any{"type": "game:meld", "seat": seat, "meldType": "peng", "tiles": []string{tile, tile, tile}})
		_ = r.srv.Send(seat, map[string]any{"type": "game:your_turn", "hand": game.SortTiles(r.hands[seat]), "reason": "peng"})
		r.broadcastState()
		r.srv.BroadcastWS(map[string]any{"event": "thinking", "data": map[string]any{"seat": seat}})
		go func() {
			action := r.srv.WaitForAction(seat, turnTimeout)
			if action == nil {
				r.mu.Lock()
				hand := r.hands[seat]
				r.mu.Unlock()
				if len(hand) > 0 {
					da := discardAction{Action: "discard", Tile: game.SortTiles(hand)[0]}
					b, _ := json.Marshal(da)
					_ = r.OnAction(seat, b)
				}
			}
		}()

	case "chi":
		r.mu.Lock()
		h := r.hands[seat]
		for _, t := range action.Use {
			h = game.RemoveTile(h, t)
		}
		r.hands[seat] = h
		meldTiles := game.SortTiles(append(action.Use, tile))
		r.melds[seat] = append(r.melds[seat], game.Meld{Type: "chi", Tiles: meldTiles, FromSeat: fromSeat})
		r.turnIndex = indexOf(seats, seat)
		r.mu.Unlock()
		r.srv.Broadcast(map[string]any{"type": "game:meld", "seat": seat, "meldType": "chi", "tiles": meldTiles})
		_ = r.srv.Send(seat, map[string]any{"type": "game:your_turn", "hand": game.SortTiles(r.hands[seat]), "reason": "chi"})
		r.broadcastState()
		r.srv.BroadcastWS(map[string]any{"event": "thinking", "data": map[string]any{"seat": seat}})
		go func() {
			action := r.srv.WaitForAction(seat, turnTimeout)
			if action == nil {
				r.mu.Lock()
				hand := r.hands[seat]
				r.mu.Unlock()
				if len(hand) > 0 {
					da := discardAction{Action: "discard", Tile: game.SortTiles(hand)[0]}
					b, _ := json.Marshal(da)
					_ = r.OnAction(seat, b)
				}
			}
		}()
	}
	return ""
}

func (r *MahjongRoom) handleExhausted() error {
	log.Println("[mahjong] Wall exhausted — draw (流局)")
	r.srv.Broadcast(map[string]any{"type": "game:gameover", "result": "draw", "reason": "exhausted"})
	r.srv.BroadcastWS(map[string]any{"event": "gameover", "data": map[string]any{"result": "draw"}})
	time.Sleep(5 * time.Second)
	r.mu.Lock()
	r.round = r.round%4 + 1
	r.mu.Unlock()
	return r.startNewGame()
}

func (r *MahjongRoom) endGame(winnerSeat, winTile string, res game.ScoringResult, isTsumo bool) {
	r.mu.Lock()
	scores := r.scores
	round := r.round
	r.mu.Unlock()
	r.srv.Broadcast(map[string]any{
		"type":    "game:gameover",
		"winner":  winnerSeat,
		"winTile": winTile,
		"points":  res.Points,
		"yaku":    res.Yaku,
		"isTsumo": isTsumo,
		"scores":  scores,
	})
	r.srv.BroadcastWS(map[string]any{"event": "gameover", "data": map[string]any{
		"winner":  winnerSeat,
		"winTile": winTile,
		"points":  res.Points,
		"yaku":    res.Yaku,
		"isTsumo": isTsumo,
		"scores":  scores,
	}})
	time.Sleep(8 * time.Second)
	r.mu.Lock()
	r.round = round%4 + 1
	r.mu.Unlock()
	_ = r.startNewGame()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func (r *MahjongRoom) availableActions(seat string, hand []string, melds []game.Meld, tile, fromSeat string) []string {
	actions := []string{"pass"}
	if game.CanHu(hand, melds, tile) {
		actions = append([]string{"hu"}, actions...)
	}
	if game.CanOpenGang(hand, tile) {
		actions = append([]string{"gang"}, actions...)
	}
	if game.CanPeng(hand, tile) {
		actions = append(actions, "peng")
	}
	if len(game.CanChi(hand, tile, seat, fromSeat)) > 0 {
		actions = append(actions, "chi")
	}
	return actions
}

func (r *MahjongRoom) updateScores(winner string, points int, loser string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if loser != "" {
		r.scores[loser] -= points
		r.scores[winner] += points
	} else {
		each := (points + 2) / 3
		for _, s := range seats {
			if s != winner {
				r.scores[s] -= each
			}
		}
		r.scores[winner] += each * 3
	}
}

func (r *MahjongRoom) broadcastState() {
	r.srv.BroadcastWS(map[string]any{"event": "state", "data": r.GetInitialState()})
}

func (r *MahjongRoom) publicState() map[string]any {
	hands := make(map[string]any, 4)
	for _, s := range seats {
		hands[s] = map[string]any{"count": len(r.hands[s])}
	}
	participants := make(map[string]any)
	for seat, p := range r.srv.Participants() {
		participants[seat] = map[string]any{"name": p.Name, "isBot": p.IsBot}
	}
	return map[string]any{
		"state":         r.state,
		"round":         r.round,
		"gameCount":     r.gameCount,
		"wallSize":      len(r.wall),
		"doraIndicator": r.doraIndicator,
		"hands":         hands,
		"melds":         r.melds,
		"discards":      r.discards,
		"scores":        r.scores,
		"participants":  participants,
	}
}

func (r *MahjongRoom) lobbyState() map[string]any {
	participants := make(map[string]any)
	for seat, p := range r.srv.Participants() {
		participants[seat] = map[string]any{"name": p.Name}
	}
	return map[string]any{
		"state":        "LOBBY",
		"participants": participants,
		"slots":        4,
	}
}

func contains(s []string, v string) bool {
	for _, t := range s {
		if t == v {
			return true
		}
	}
	return false
}

func indexOf(s []string, v string) int {
	for i, t := range s {
		if t == v {
			return i
		}
	}
	return -1
}
