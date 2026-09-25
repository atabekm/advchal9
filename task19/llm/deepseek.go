// Package llm is a minimal DeepSeek chat/completions client with tool support.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const DefaultBaseURL = "https://api.deepseek.com"

// Message is one entry of an OpenAI-style chat history.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
	// Thinking models return their reasoning separately; DeepSeek asks for it
	// to be sent back within a tool-calling turn, so it is kept, not dropped.
	ReasoningContent string     `json:"reasoning_content,omitempty"`
	ToolCalls        []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID       string     `json:"tool_call_id,omitempty"`
}

type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function FunctionCall `json:"function"`
}

type FunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"` // a JSON document encoded as a string
}

// FunctionTool is the chat-completions tool definition.
type FunctionTool struct {
	Type     string      `json:"type"`
	Function FunctionDef `json:"function"`
}

type FunctionDef struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Parameters  any    `json:"parameters"`
}

type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
}

func (u *Usage) Add(o Usage) {
	u.PromptTokens += o.PromptTokens
	u.CompletionTokens += o.CompletionTokens
}

// DeepSeek is a minimal chat/completions client with tool support.
type DeepSeek struct {
	BaseURL string
	APIKey  string
	Model   string
	HTTP    *http.Client
}

func NewDeepSeek(key, model string) *DeepSeek {
	return &DeepSeek{BaseURL: DefaultBaseURL, APIKey: key, Model: model, HTTP: &http.Client{Timeout: 120 * time.Second}}
}

type chatRequest struct {
	Model    string         `json:"model"`
	Messages []Message      `json:"messages"`
	Tools    []FunctionTool `json:"tools,omitempty"`
}

type chatResponse struct {
	Choices []struct {
		Message      Message `json:"message"`
		FinishReason string  `json:"finish_reason"`
	} `json:"choices"`
	Usage Usage `json:"usage"`
}

// Complete sends one request. Passing no tools forces a plain-text answer.
func (d *DeepSeek) Complete(ctx context.Context, msgs []Message, tools []FunctionTool) (Message, Usage, error) {
	body, err := json.Marshal(chatRequest{Model: d.Model, Messages: msgs, Tools: tools})
	if err != nil {
		return Message{}, Usage{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return Message{}, Usage{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+d.APIKey)

	resp, err := d.HTTP.Do(req)
	if err != nil {
		return Message{}, Usage{}, fmt.Errorf("deepseek unreachable: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return Message{}, Usage{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return Message{}, Usage{}, apiError(resp.StatusCode, raw)
	}
	var cr chatResponse
	if err := json.Unmarshal(raw, &cr); err != nil {
		return Message{}, Usage{}, fmt.Errorf("decoding deepseek response: %w", err)
	}
	if len(cr.Choices) == 0 {
		return Message{}, cr.Usage, errors.New("deepseek returned no choices")
	}
	m := cr.Choices[0].Message
	m.Role = "assistant"
	return m, cr.Usage, nil
}

func apiError(status int, body []byte) error {
	var e struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	msg := strings.TrimSpace(string(body))
	if json.Unmarshal(body, &e) == nil && e.Error.Message != "" {
		msg = e.Error.Message
	}
	if len(msg) > 300 {
		msg = msg[:300] + "…"
	}
	hint := ""
	switch status {
	case 401:
		hint = " (check DEEPSEEK_API_KEY)"
	case 402:
		hint = " (insufficient balance)"
	case 429:
		hint = " (rate limited, retry shortly)"
	}
	return fmt.Errorf("deepseek HTTP %d: %s%s", status, msg, hint)
}

var ErrNoKey = errors.New("DEEPSEEK_API_KEY is not set")

// APIKey reads DEEPSEEK_API_KEY, falling back to a .env in the working dir.
func APIKey() (string, error) {
	if k := strings.TrimSpace(os.Getenv("DEEPSEEK_API_KEY")); k != "" {
		return k, nil
	}
	b, err := os.ReadFile(".env")
	if err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			k, v, ok := strings.Cut(strings.TrimSpace(l), "=")
			if ok && strings.TrimSpace(strings.TrimPrefix(k, "export ")) == "DEEPSEEK_API_KEY" {
				if v = strings.Trim(strings.TrimSpace(v), `"'`); v != "" {
					return v, nil
				}
			}
		}
	}
	return "", ErrNoKey
}
