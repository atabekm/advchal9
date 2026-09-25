// sumserver serves one MCP tool, summarize, over Streamable HTTP. It holds
// its own DeepSeek key: the model behind the tool is the server's business,
// not the client's.
package main

import (
	"flag"
	"fmt"
	"os"

	"task19/llm"
	"task19/mcpserve"
	"task19/summarize"
)

func main() {
	addr := flag.String("addr", "localhost:8772", "listen address")
	model := flag.String("model", "deepseek-flash", "DeepSeek model used for summaries")
	flag.Parse()
	key, err := llm.APIKey()
	if err != nil {
		fmt.Fprintln(os.Stderr, "sumserver:", err, "— export DEEPSEEK_API_KEY=sk-…  (or put it in a .env file here)")
		os.Exit(2)
	}
	sm := &summarize.Summarizer{LLM: llm.NewDeepSeek(key, *model)}
	os.Exit(mcpserve.Run(mcpserve.Config{
		Addr: *addr, Server: summarize.NewServer(sm), Name: summarize.ServerName, Version: summarize.ServerVersion,
		Details: [][2]string{{"tool", "summarize"}, {"model", *model}},
	}))
}
