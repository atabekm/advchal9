// fileserver serves four MCP tools over Streamable HTTP: save, append, read
// and list. It reads and writes in -dir and nowhere else.
package main

import (
	"flag"
	"os"
	"path/filepath"
	"strings"

	"task20/files"
	"task20/mcpserve"
)

func main() {
	addr := flag.String("addr", "localhost:8773", "listen address")
	dir := flag.String("dir", "out", "directory files are read from and written to")
	flag.Parse()
	abs, _ := filepath.Abs(*dir)
	os.Exit(mcpserve.Run(mcpserve.Config{
		Addr: *addr, Server: files.NewServer(&files.Store{Dir: *dir}), Name: files.ServerName, Version: files.ServerVersion,
		Details: [][2]string{{"tools", strings.Join(files.Tools, ", ")}, {"dir", abs}},
	}))
}
