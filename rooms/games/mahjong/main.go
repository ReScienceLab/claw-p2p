package main

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strconv"

	"github.com/ReScienceLab/DeClaw/rooms/sdk"
)

func main() {
	room := newMahjongRoom()

	// Dashboard static files are next to the binary
	_, file, _, _ := runtime.Caller(0)
	dashDir := filepath.Join(filepath.Dir(file), "dashboard")
	if _, err := os.Stat(dashDir); err != nil {
		// Fallback: look next to executable
		exe, _ := os.Executable()
		dashDir = filepath.Join(filepath.Dir(exe), "dashboard")
	}

	srv := sdk.NewServer(sdk.ServerConfig{
		Room:          room,
		Name:          getenv("ROOM_NAME", "DeClaw Mahjong"),
		Slots:         4,
		Port:          envInt("P2P_PORT", 8099),
		DashPort:      envInt("DASH_PORT", 8080),
		DataDir:       getenv("DATA_DIR", "/tmp/declaw-mahjong"),
		YggMode:       sdk.YggModeAuto,
		DashStaticDir: dashDir,
		TestMode:      os.Getenv("TEST_MODE") == "true",
	})
	room.srv = srv

	// Wire the dashboard state function
	if srv != nil {
		// srv.dashboard is set during Start(), so we hook after
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := srv.Start(ctx); err != nil {
		log.Fatalf("[mahjong] Fatal: %v", err)
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}
