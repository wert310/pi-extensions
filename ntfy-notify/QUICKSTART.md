# Quick Start Guide

## 1. Configure Your Token

Set the token in your environment (add to `~/.bashrc` or `~/.zshrc`):

```bash
export PI_NTFY_TOKEN="tk_your_token_here"
```

Optionally configure other settings:

```bash
export PI_NTFY_SERVER="ntfy.puyral.fr"
export PI_NTFY_TOPIC="ai-pi-notifications"
```

## 2. Subscribe to Notifications

### Mobile (Recommended)

1. Install ntfy app (iOS/Android)
2. Add server: `https://ntfy.puyral.fr`
3. Subscribe to: `ai-pi-notifications`
4. Configure authentication with your token

### Desktop

Visit: https://ntfy.puyral.fr/ai-pi-notifications

(Enable browser notifications when prompted)

## 3. Test It

In pi, run:

```
/ntfy-test
```

You should receive a notification!

## 4. Use It

Just use pi normally. You'll get notified when:

- ✅ Agent finishes a task and waits for your input
- ⚠️ A tool error occurs

That's it! 🎉

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_NTFY_TOKEN` | *(required)* | Your authentication token |
| `PI_NTFY_SERVER` | `ntfy.puyral.fr` | ntfy server URL |
| `PI_NTFY_TOPIC` | `ai-pi-{project}` | Topic name (must start with `ai` or `llm`) |
| `PI_NTFY_ENABLED` | `true` | Enable/disable notifications |
| `PI_NTFY_NOTIFY_AGENT_END` | `true` | Notify when agent finishes |
| `PI_NTFY_NOTIFY_ERROR` | `true` | Notify on tool errors |
| `PI_NTFY_NOTIFY_SHUTDOWN` | `false` | Notify on session shutdown |

## Alternative: settings.json

Add to `~/.pi/agent/settings.json`:

```json
{
  "ntfy": {
    "server": "ntfy.puyral.fr",
    "token": "tk_your_token_here",
    "topic": "ai-pi-notifications",
    "enabled": true,
    "notifyOn": {
      "agentEnd": true,
      "sessionShutdown": false,
      "error": true
    }
  }
}
```

## Troubleshooting

**No notification?**
- Check token is set: `echo $PI_NTFY_TOKEN`
- Verify you're subscribed to the correct topic
- Run `/ntfy-test` to verify configuration

**Topic permission error?**
- Your token only allows topics starting with `ai` or `llm`
- Use topic names like `ai-pi-notifications` or `llm-assistant`
