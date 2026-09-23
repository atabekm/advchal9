// olserver is an MCP server over stdio exposing Open Library as two tools,
// search_books and get_work. It is meant to be spawned by an MCP client
// (bookagent, mcpls, Claude Code…), not run by hand: stdout carries JSON-RPC.
package main

import (
	"context"
	"fmt"
	"log"
	"os"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"task17/openlibrary"
)

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "-h" || os.Args[1] == "--help" || os.Args[1] == "-version") {
		fmt.Fprintf(os.Stderr, "%s %s — MCP server for Open Library (stdio)\n"+
			"tools: search_books, get_work\n"+
			"usage: spawn from an MCP client, e.g.  mcpls -- %s\n",
			openlibrary.ServerName, openlibrary.ServerVersion, os.Args[0])
		return
	}
	// Logs go to stderr; stdout belongs to the protocol.
	log.SetOutput(os.Stderr)
	log.SetPrefix("olserver: ")

	server := openlibrary.NewServer(openlibrary.NewClient())
	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		log.Fatal(err)
	}
}
