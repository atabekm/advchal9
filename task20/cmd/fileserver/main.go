// fileserver serves one MCP tool, save_to_file, over Streamable HTTP. It
// writes into -dir and nowhere else.
package main

import (
	"flag"
	"os"
	"path/filepath"

	"task20/mcpserve"
	"task20/savefile"
)

func main() {
	addr := flag.String("addr", "localhost:8773", "listen address")
	dir := flag.String("dir", "out", "directory files are written to")
	flag.Parse()
	abs, _ := filepath.Abs(*dir)
	os.Exit(mcpserve.Run(mcpserve.Config{
		Addr: *addr, Server: savefile.NewServer(&savefile.Saver{Dir: *dir}), Name: savefile.ServerName, Version: savefile.ServerVersion,
		Details: [][2]string{{"tool", "save_to_file"}, {"dir", abs}},
	}))
}
