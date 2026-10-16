# devnull-mcp

An MCP server for [/dev/null](https://dev-null.sh), the plain-text social network for developers.
It lets Claude (or any MCP client) commit to /dev/null as you, and read public profiles and commits.

There is no login. A commit is signed locally with `ssh-keygen -Y sign`, using an SSH key that is on
your GitHub account, and /dev/null checks the signature against the keys GitHub publishes for you,
exactly like the official `curl -fsSL https://dev-null.sh/commit | bash` script does.

## Tools

| Tool | What it does |
| --- | --- |
| `devnull_commit` | Publish a commit (up to 4000 characters), optionally as a reply (`reply_to` takes a short hash, UUID or link). |
| `devnull_whoami` | Shows which local SSH key /dev/null recognizes as yours. Posts nothing. |
| `devnull_get_user` | Public profile of a user by GitHub username. |
| `devnull_list_commits` | A user's latest commits (or replies), 20 per page with a cursor. |
| `devnull_get_commit` | One commit by UUID or link. |

## Requirements

- Node.js 20 or newer, `ssh-keygen` (OpenSSH 8.0+).
- An Ed25519 or RSA key that is on your GitHub account, either loaded in your SSH agent or as
  `~/.ssh/<name>` with `~/.ssh/<name>.pub` next to it. Passphrase-protected keys must be in the agent
  (`ssh-add ~/.ssh/<name>`), because the server has no terminal to ask for the passphrase.
- Having signed in once on https://dev-null.sh with GitHub.

## Install

```bash
npm install
npm run build
```

Register it with Claude Code (user scope, so it is available in every project):

```bash
claude mcp add --scope user devnull -- node /absolute/path/to/devnull-mcp/dist/index.js
```

Or add it to any MCP client configuration:

```json
{
  "mcpServers": {
    "devnull": {
      "command": "node",
      "args": ["/absolute/path/to/devnull-mcp/dist/index.js"]
    }
  }
}
```

### Environment variables

| Variable | Purpose |
| --- | --- |
| `DEVNULL_SSH_KEY` | Path to the private key to sign with, when auto-discovery picks the wrong one. Its public key is derived with `ssh-keygen -y`. |
| `DEVNULL_URL` | Another instance, for development. Must be `https://`, or `http://localhost`. |

## How a commit works

1. The public keys from `ssh-add -L` and `~/.ssh/*.pub` are sent to `POST /api/cli/key-lookups`,
   which answers with the one that belongs to a /dev/null user. Public keys are public: GitHub
   publishes them at `https://github.com/<you>.keys`.
2. The payload `timestamp\nnonce\nreply_to\nmessage` is signed with that key in the
   `devnull-commit` namespace. The signature is only valid for /dev/null commits.
3. The payload and signature go to `POST /api/cli/commits`, which answers with the commit link.

Private keys are never read by this code: `ssh-keygen` or the agent uses them. Temporary files are
written to a fresh private directory that is deleted afterwards.

## Development

```bash
npm test          # node:test suite, includes a real ssh-keygen sign/verify round trip
npm run typecheck
npm run dev       # run from sources over stdio
```
