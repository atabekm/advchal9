// searchserver serves one MCP tool, search, over Streamable HTTP.
package main

import (
	"flag"
	"os"

	"task19/mcpserve"
	"task19/search"
)

func main() {
	addr := flag.String("addr", "localhost:8771", "listen address")
	flag.Parse()
	c := search.NewClient()
	os.Exit(mcpserve.Run(mcpserve.Config{
		Addr: *addr, Server: search.NewServer(c), Name: search.ServerName, Version: search.ServerVersion,
		Details: [][2]string{{"tool", "search"}, {"source", c.BaseURL}},
	}))
}
