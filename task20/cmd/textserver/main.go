// textserver serves three MCP tools over Streamable HTTP: summarize, extract
// and compare. It holds its own DeepSeek key: the model behind the tools is
// the server's business, not the client's.
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"task20/llm"
	"task20/mcpserve"
	"task20/texttools"
)

func main() {
	addr := flag.String("addr", "localhost:8772", "listen address")
	model := flag.String("model", "deepseek-flash", "DeepSeek model behind the tools")
	flag.Parse()
	key, err := llm.APIKey()
	if err != nil {
		fmt.Fprintln(os.Stderr, "textserver:", err, "— export DEEPSEEK_API_KEY=sk-…  (or put it in a .env file here)")
		os.Exit(2)
	}
	e := &texttools.Engine{LLM: llm.NewDeepSeek(key, *model)}
	os.Exit(mcpserve.Run(mcpserve.Config{
		Addr: *addr, Server: texttools.NewServer(e), Name: texttools.ServerName, Version: texttools.ServerVersion,
		Details: [][2]string{{"tools", strings.Join(texttools.Tools, ", ")}, {"model", *model}},
	}))
}
