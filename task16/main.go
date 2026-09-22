package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"time"
)

const version = "0.1.0"

// Exit codes, so mcpls can be branched on from a shell script:
//
//	0  connected and listed
//	1  connection or protocol failure
//	2  usage error
const (
	exitOK    = 0
	exitConn  = 1
	exitUsage = 2
)

func main() {
	os.Exit(run())
}

func run() int {
	var (
		asJSON      bool
		showSchema  bool
		full        bool
		interactive bool
		noColor     bool
		verbose     bool
		timeout     time.Duration
		regPath     string
	)

	fs := flag.NewFlagSet("mcpls", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	fs.BoolVar(&asJSON, "json", false, "emit the raw result as JSON")
	fs.BoolVar(&interactive, "i", false, "browse servers and tools interactively")
	fs.BoolVar(&showSchema, "schema", false, "print each tool's full input schema")
	fs.BoolVar(&full, "full", false, "print complete descriptions instead of clipping them")
	fs.BoolVar(&noColor, "no-color", false, "disable ANSI colour")
	fs.BoolVar(&verbose, "v", false, "log every JSON-RPC method to stderr")
	fs.DurationVar(&timeout, "timeout", 30*time.Second, "give up if the handshake takes longer")
	fs.StringVar(&regPath, "servers", "", "path to an alternate servers.json")
	fs.Usage = func() { usage(fs) }

	// Everything after `--` is a literal command to run, and must not be parsed
	// as mcpls flags — `mcpls -- npx -y pkg --some-server-flag` has to reach the
	// server intact.
	args, adHoc := splitAtDoubleDash(os.Args[1:])
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	rest := fs.Args()

	stdoutColor := colorEnabled(os.Stdout, noColor)
	r := newRenderer(os.Stdout, newStyle(stdoutColor))
	errR := newRenderer(os.Stderr, newStyle(colorEnabled(os.Stderr, noColor)))

	reg, err := loadRegistry(regPath)
	if err != nil {
		errR.failure(err)
		return exitUsage
	}

	// Subcommands. `servers` and `version` never open a connection.
	if len(rest) > 0 && adHoc == nil {
		switch rest[0] {
		case "servers", "ls":
			r.servers(reg, loadCounts())
			return exitOK
		case "version":
			fmt.Printf("mcpls %s\n", version)
			return exitOK
		case "help":
			usage(fs)
			return exitOK
		}
	}

	// Ctrl-C should close the child process, not orphan it.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	if interactive {
		if adHoc != nil {
			errR.failure(fmt.Errorf("-i browses the registry; it cannot be combined with `--`"))
			return exitUsage
		}
		start := ""
		if len(rest) > 0 {
			start = rest[0]
			if _, err := reg.resolve(start, nil); err != nil {
				errR.failure(err)
				return exitUsage
			}
		}
		return newBrowser(ctx, reg, r, os.Stdin, timeout).run(start)
	}

	// Resolve what to connect to: an explicit command after `--`, or a
	// registry name (possibly with extra arguments), or the default entry.
	var (
		entry     ServerEntry
		cacheName string
	)
	switch {
	case len(adHoc) > 0:
		entry = ServerEntry{Transport: "stdio", Command: adHoc[0], Args: adHoc[1:]}
	case adHoc != nil:
		errR.failure(fmt.Errorf("`--` must be followed by a command to run"))
		return exitUsage
	default:
		name := ""
		if len(rest) > 0 {
			name = rest[0]
			rest = rest[1:]
		}
		entry, err = reg.resolve(name, rest)
		if err != nil {
			errR.failure(err)
			return exitUsage
		}
		cacheName = name
		if cacheName == "" {
			cacheName = reg.Default
		}
	}

	// In --json mode stdout is reserved for the JSON document, so the live
	// progress lines go to stderr and the output stays pipeable.
	progress := r
	if asJSON {
		progress = errR
	}

	progress.header(entry)

	// With -v the method is announced before it is sent, so an interrupted run
	// shows which call was still in flight.
	var onStart func(string)
	if verbose {
		onStart = func(method string) {
			fmt.Fprintf(os.Stderr, "    → %s\n", method)
		}
	}

	insp, err := inspect(ctx, entry, timeout, progress.step, onStart)
	if err != nil {
		progress.failure(err)
		return exitConn
	}

	if cacheName != "" {
		saveCount(cacheName, len(insp.Tools))
	}

	if asJSON {
		b, err := insp.toJSON()
		if err != nil {
			errR.failure(err)
			return exitConn
		}
		fmt.Println(string(b))
		return exitOK
	}

	r.serverInfo(insp)
	r.tools(insp, showSchema, full)
	return exitOK
}

// splitAtDoubleDash returns the arguments before `--` and those after it. A nil
// second result means `--` was absent; an empty non-nil one means it was
// present but nothing followed.
func splitAtDoubleDash(argv []string) (before []string, after []string) {
	for i, a := range argv {
		if a == "--" {
			return argv[:i], append([]string{}, argv[i+1:]...)
		}
	}
	return argv, nil
}

func usage(fs *flag.FlagSet) {
	out := fs.Output()
	fmt.Fprint(out, strings.TrimLeft(`
mcpls · connect to an MCP server over stdio and list its tools

USAGE
  mcpls [flags] [server] [server args...]
  mcpls [flags] -- <command> [args...]
  mcpls -i [server]
  mcpls servers
  mcpls version

EXAMPLES
  mcpls                                 connect to the default server
  mcpls filesystem ~/Projects           named server, with its own argument
  mcpls -i                              browse servers and tools interactively
  mcpls -- npx -y @modelcontextprotocol/server-memory
  mcpls --json | jq '.tools[].name'

FLAGS
`, "\n"))
	fs.PrintDefaults()
	fmt.Fprint(out, "\nEXIT CODES\n  0 listed · 1 connection failure · 2 usage error\n\n")
}
