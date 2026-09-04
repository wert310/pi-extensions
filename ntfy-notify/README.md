# Pi ntfy Notification Extension

Send [ntfy](https://ntfy.sh/) push notifications when your pi session needs attention.

## Features

- **Automatic notifications** when the agent finishes and is ready for input
- **Error alerts** when tools fail
- **Session lifecycle** notifications (optional)
- **Custom notifications** via command or LLM-callable tool
- **Configurable** server, topic, and notification preferences
- **Privacy-focused**: Uses your private ntfy server

## Installation

This extension is located in `~/.pi/agent/extensions/ntfy-notify.ts`.

To install, either:
1. Copy the file to `~/.pi/agent/extensions/ntfy-notify.ts` (already done)
2. Or reference it in your `settings.json`:
   ```json
   {
     "extensions": ["~/.pi/agent/extensions/ntfy-notify.ts"]
   }
   ```

## Configuration

### Environment Variables (Recommended)

Set these in your shell profile (`~/.bashrc`, `~/.zshrc`, etc.):

```bash
# Required: Your ntfy authentication token
export PI_NTFY_TOKEN="tk_your_token_here"

# Optional: ntfy server (default: ntfy.puyral.fr)
export PI_NTFY_SERVER="ntfy.puyral.fr"

# Optional: Topic name (default: ai-pi-{cwd-basename})
export PI_NTFY_TOPIC="ai-pi-notifications"

# Optional: Disable notifications (default: true)
export PI_NTFY_ENABLED="true"

# Optional: Notification triggers (defaults: agentEnd=true, error=true, shutdown=false)
export PI_NTFY_NOTIFY_AGENT_END="true"
export PI_NTFY_NOTIFY_ERROR="true"
export PI_NTFY_NOTIFY_SHUTDOWN="false"
```

### Settings.json Configuration

Alternatively, you can configure via `settings.json` (future enhancement - currently uses env vars):

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

## Topic Naming

The extension uses topics under `ai*` or `llm*` as required by your token permissions.

Default topic format: `ai-pi-{session-name}` or `ai-pi-{project-folder}`

Examples:
- `ai-pi-myproject` - Project-specific notifications
- `ai-pi-work` - General work notifications
- `llm-pi-assistant` - Alternative naming

## Usage

### Automatic Notifications

Once configured, the extension automatically sends notifications when:

1. **Agent finishes** (default): When pi completes a task and waits for your input
2. **Tool errors** (default): When a tool execution fails
3. **Session shutdown** (optional): When a session ends

### Test Notification

Use the `/ntfy-test` command to verify your configuration:

```
/ntfy-test
```

You should receive a test notification on your subscribed devices.

### Custom Notifications (LLM Tool)

The extension provides an `ntfy_notify` tool that the LLM can call:

```typescript
// Example: Ask pi to send a custom notification
"Send me a ntfy notification when the build is complete with title 'Build Done' and message 'Compilation successful'"
```

The LLM will use the tool with parameters:
- `title`: Notification title
- `message`: Notification body
- `priority`: 1-5 (optional, default 3)
- `tags`: Array of emoji tags (optional)

### Custom Notifications (Command)

For programmatic use, you can also send notifications via the registered tool.

## Priority Levels

| Priority | Value | Use Case |
|----------|-------|----------|
| Min | 1 | Low-priority updates |
| Low | 2 | Informational |
| Default | 3 | Normal notifications |
| High | 4 | Important alerts |
| Urgent | 5 | Critical errors |

## Emoji Tags

Common tags for notifications:
- `bell` - General notification
- `computer` - Computer/tech related
- `warning` - Warnings
- `x` - Errors/failures
- `white_check_mark` - Success
- `tada` - Celebration/completion
- `information` - Informational
- `hourglass` - Waiting/processing

See [ntfy emoji tags](https://ntfy.sh/features/#emoji-tags) for the full list.

## Subscribing to Notifications

### Mobile (iOS/Android)

1. Install the ntfy app from your app store
2. Add your server: `https://ntfy.puyral.fr`
3. Subscribe to your topic: `ai-pi-notifications` (or your custom topic)
4. Enter your token in the app settings for authentication

### Desktop (Linux/macOS/Windows)

**Option 1: Web App**
- Visit `https://ntfy.puyral.fr`
- Subscribe to your topic
- Enable browser notifications

**Option 2: Command Line**
```bash
# Subscribe and receive notifications
curl -n 'https://ntfy.puyral.fr/ai-pi-notifications/json' \
  -H "Authorization: Bearer tk_your_token_here"
```

**Option 3: Desktop Clients**
- [ntfy-desktop](https://github.com/binwiederhier/ntfy-desktop) (Windows/macOS)
- Various third-party clients available

## Troubleshooting

### No notifications received

1. Check that `PI_NTFY_TOKEN` is set correctly
2. Verify you're subscribed to the correct topic
3. Check the token has permissions for your topic (must match `ai*` or `llm*`)
4. Run `/ntfy-test` to verify configuration

### Notifications failing

Check the pi console output for error messages like:
```
[ntfy] Notification failed: 401 Unauthorized
```

This usually indicates:
- Invalid token
- Token doesn't have permission for the topic
- Server URL is incorrect

### Topic permission errors

Your token only allows topics matching:
- `ai*` (e.g., `ai-pi-notifications`, `ai-myproject`)
- `llm*` (e.g., `llm-pi-assistant`)

Make sure your topic name starts with `ai` or `llm`.

## Security Notes

- **Never share your token**: It provides write access to your topics
- **Use HTTPS**: Always use HTTPS for the ntfy server
- **Token permissions**: Your token only allows specific topic patterns
- **Environment variables**: Prefer env vars over hardcoding tokens in config files

## Example Workflows

### Long-running tasks

```bash
# Start pi with a long task
pi "Refactor the entire codebase to use TypeScript"

# Get notified when it's done via ntfy
# (Walk away, come back when you get the notification)
```

### Remote development

```bash
# SSH into remote server
ssh dev-server

# Start pi task
pi "Run the full test suite and fix any failures"

# Get notified on your phone when complete
```

### CI/CD integration

Use the `ntfy_notify` tool in automated workflows:

```typescript
// In a pi session monitoring CI
pi "Watch the CI pipeline and notify me when it completes"
```

## License

MIT
