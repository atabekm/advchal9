// searchserver serves five read-only MCP tools over Streamable HTTP:
// wikipedia and wiki_article, hackernews, books and book.
package main

import (
	"flag"
	"os"
	"strings"

	"task20/mcpserve"
	"task20/search"
)

func main() {
	addr := flag.String("addr", "localhost:8771", "listen address")
	flag.Parse()
	src := search.NewSources()
	os.Exit(mcpserve.Run(mcpserve.Config{
		Addr: *addr, Server: search.NewServer(src), Name: search.ServerName, Version: search.ServerVersion,
		Details: [][2]string{
			{"tools", strings.Join(search.Tools, ", ")},
			{"sources", strings.Join([]string{src.Wiki.BaseURL, src.HN.BaseURL, src.Library.BaseURL}, " · ")},
		},
	}))
}
