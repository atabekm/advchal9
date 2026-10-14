# Task 32 — Automated code review

Every pull request in this repository gets a review from a local model. A GitHub Actions job on
a self-hosted runner (this Mac, next to Ollama) takes the PR's diff, looks up related
documentation and code, and posts one comment with **potential bugs**, **architectural issues**
and **recommendations**.

## The runner

The job needs Ollama, so it runs on a self-hosted runner on the machine that has it. The runner
connects out to GitHub and waits for jobs; nothing has to be opened in the firewall. Jobs queue on
GitHub while the Mac is off and start when it is back.

1. **Register it.** GitHub → the repository → Settings → Actions → Runners → *New self-hosted
   runner* → macOS, ARM64. Run the download commands it shows, then configure with the
   `ollama` label the workflow asks for:

   ```bash
   mkdir ~/actions-runner && cd ~/actions-runner
   curl -o runner.tar.gz -L <the URL from the page>
   tar xzf runner.tar.gz
   ./config.sh --url https://github.com/atabekm/advchal9 --token <TOKEN> \
       --name mac-ollama --labels ollama --unattended
   ```

   The token is on that page, or: `gh api -X POST repos/atabekm/advchal9/actions/runners/registration-token --jq .token`.

2. **Check its PATH.** `config.sh` saves the shell's `PATH` to `.path`, and jobs run with it. It
   must contain the folders of `uv` and `gh` (`/opt/homebrew/bin`) and `ollama`
   (`/usr/local/bin`): `cat .path`. If not, `echo "$PATH" > .path`.

3. **Run it**: `./run.sh` in a terminal, or as a LaunchAgent that starts at login:
   `./svc.sh install && ./svc.sh start`. Either way it runs as you, so it sees Ollama on
   `localhost:11434`, the Hugging Face cache (the reranker) and `~/.cache/devreview/index.db`.

4. **Keep forks out.** The repository is public, and a self-hosted runner executes whatever a
   workflow tells it to. The workflow's job runs only when the PR's branch is in this repository
   (`head.repo.full_name == github.repository`); as a second lock, Settings → Actions → General →
   *Approval for running fork pull request workflows* → *Require approval for all external
   contributors*.

To remove it: `./svc.sh stop && ./svc.sh uninstall && ./config.sh remove --token <TOKEN>`.
