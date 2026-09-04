# Pi ntfy Notification Extension - Design Document

## Overview

This extension integrates pi with [ntfy](https://ntfy.sh/), a simple HTTP-based pub-sub notification service, to send push notifications when the session needs user attention.

## Requirements

### Functional Requirements

1. **Automatic Notifications**: Send notifications when:
   - Agent completes a task and waits for user input
   - A tool execution fails
   - Session shuts down (optional)

2. **Configuration**: Support configurable:
   - ntfy server URL (default: `ntfy.puyral.fr`)
   - Authentication token
   - Topic name (must match `ai*` or `llm*` patterns)
   - Notification triggers (enable/disable per event type)

3. **Manual Notifications**: Provide mechanisms for:
   - Command-line testing (`/ntfy-test`)
   - LLM-callable tool (`ntfy_notify`)

4. **Privacy**: Use user's private ntfy server with token authentication

### Non-Functional Requirements

1. **Non-blocking**: Notifications should not block pi's main workflow
2. **Graceful degradation**: Fail silently if ntfy is unavailable
3. **Security**: Never log tokens or expose them in error messages
4. **Minimal dependencies**: Use only built-in Node.js APIs

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────────┐
│                     pi Extension Runtime                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ Event Hooks  │  │   Commands   │  │     Tools    │       │
│  │              │  │              │  │              │       │
│  │ - agent_end  │  │ - ntfy-test  │  │ - ntfy_notify│       │
│  │ - tool_result│  │              │  │              │       │
│  │ - session_*  │  │              │  │              │       │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘       │
│         │                 │                 │                │
│         └────────────┬────┴─────────────────┘                │
│                      │                                       │
│                      ▼                                       │
│            ┌─────────────────┐                              │
│            │ Config Manager  │                              │
│            │                 │                              │
│            │ - settings.json │                              │
│            │ - Env vars      │                              │
│            └────────┬────────┘                              │
│                     │                                       │
│                     ▼                                       │
│            ┌─────────────────┐                              │
│            │  ntfy Client    │                              │
│            │                 │                              │
│            │ - HTTP POST     │                              │
│            │ - Auth headers  │                              │
│            │ - Error handle  │                              │
│            └────────┬────────┘                              │
│                     │                                       │
└─────────────────────┼───────────────────────────────────────┘
                      │
                      ▼
            ┌─────────────────┐
            │  ntfy Server    │
            │  ntfy.puyral.fr │
            │                 │
            │ Topic: ai-*     │
            │       llm-*     │
            └─────────────────┘
```

### Event Flow

```
User sends prompt
       │
       ▼
┌─────────────┐
│ agent_start │
└─────────────┘
       │
       ▼
┌─────────────┐
│ turn_start  │
└─────────────┘
       │
       ▼
┌─────────────┐
│ tool_call   │───┐
└─────────────┘   │
       │          │
       ▼          │
┌─────────────┐   │
│tool_result  │◄──┘ (error notifications)
└─────────────┘
       │
       ▼
┌─────────────┐
│ agent_end   │──────► Send "Ready for input" notification
└─────────────┘
```

## Configuration Strategy

### Priority Order

1. **Environment Variables** (highest priority)
   - `PI_NTFY_SERVER`
   - `PI_NTFY_TOKEN`
   - `PI_NTFY_TOPIC`
   - `PI_NTFY_ENABLED`
   - `PI_NTFY_NOTIFY_*`

2. **settings.json** (medium priority)
   - `ntfy.server`
   - `ntfy.token`
   - `ntfy.topic`
   - `ntfy.enabled`
   - `ntfy.notifyOn.*`

3. **Defaults** (lowest priority)
   - Server: `ntfy.puyral.fr`
   - Enabled: `true`
   - Topic: `ai-pi-{cwd-basename}`
   - notifyOn.agentEnd: `true`
   - notifyOn.error: `true`
   - notifyOn.sessionShutdown: `false`

### Rationale

- **Environment variables** are preferred for secrets (tokens)
- **settings.json** provides persistent configuration
- **Defaults** ensure sensible behavior with minimal setup

## Event Selection

### Selected Events

| Event | Default | Rationale |
|-------|---------|-----------|
| `agent_end` | ✅ | Primary use case: notify when ready for input |
| `tool_result` (error) | ✅ | Alert on failures that need attention |
| `session_shutdown` | ❌ | Optional, can be noisy |
| `session_start` | ❌ | Not attention-needed |
| `turn_start/end` | ❌ | Too frequent |

### Future Events (not implemented)

- `before_agent_start` with long-running task detection
- `message_end` for specific message types
- Custom threshold-based notifications (e.g., after N turns)

## Security Considerations

### Token Handling

1. **Never log tokens**: Error messages exclude token values
2. **Environment variable support**: Allows secure injection
3. **Token validation**: Check for presence before sending

### Topic Permissions

The token only allows topics matching:
- Topics matching `ai*`
- Topics matching `llm*`

The extension enforces this by:
- Defaulting to `ai-pi-*` topic pattern
- Documenting the restriction
- Letting ntfy server reject invalid topics

### HTTPS Only

Always use HTTPS for the ntfy server to protect:
- Token in Authorization header
- Notification content
- Topic names

## Error Handling

### Graceful Degradation

```typescript
try {
  const response = await fetch(url, { ... });
  if (!response.ok) {
    console.error(`[ntfy] Notification failed: ${response.status}`);
    // Don't throw - notification is non-critical
  }
} catch (error) {
  console.error(`[ntfy] Failed to send notification: ${error.message}`);
  // Continue without notification
}
```

### Error Categories

| Error Type | Handling |
|------------|----------|
| Network failure | Log and continue |
| 401 Unauthorized | Log (token may be invalid) |
| 403 Forbidden | Log (topic permission issue) |
| 404 Not Found | Log (topic doesn't exist) |
| Server error | Log and retry next time |

## Testing Strategy

### Manual Testing

1. **Configuration test**: `/ntfy-test` command
2. **Automatic test**: Run any pi task and verify notification
3. **Error test**: Trigger a tool error and verify alert

### Integration Testing

```typescript
// Test configuration loading
const config = getNtfyConfig(ctx);
assert(config !== null, "Config should load with valid token");

// Test notification sending
await sendNtfyNotification(config, "Test", "Message");
// Verify via ntfy subscription
```

## Future Enhancements

### Planned Features

1. **Smart notifications**: Detect long-running tasks
2. **Batch notifications**: Group multiple events
3. **Custom sounds**: Per-event notification sounds
4. **Rich content**: Include code snippets in notifications
5. **Rate limiting**: Prevent notification spam

### Possible Integrations

1. **Home Assistant**: Trigger automations on notifications
2. **Discord/Slack**: Alternative notification channels
3. **Email fallback**: Send email if ntfy fails
4. **Desktop notifications**: Local OS notifications as backup

## File Structure

```
~/.pi/agent/extensions/
├── ntfy-notify.ts              # Main extension code
└── ntfy-notify/
    ├── README.md               # User documentation
    ├── DESIGN.md               # This file
    └── settings.example.json   # Configuration template
```

## Dependencies

### Required

- Node.js `fetch` API (built-in in Node 18+)
- pi Extension API (`@earendil-works/pi-coding-agent`)
- TypeBox (for tool parameter schemas)

### Optional

- None (designed for minimal dependencies)

## Performance Considerations

1. **Async notifications**: All sends are non-blocking
2. **No retries**: Failed notifications are not retried (avoid delays)
3. **Minimal processing**: Configuration cached per session
4. **Small payloads**: Keep notification bodies concise

## Compatibility

### Supported Platforms

- ✅ Linux (all distributions)
- ✅ macOS
- ✅ Windows (WSL and native)
- ✅ Remote SSH sessions

### ntfy Server Compatibility

- ✅ ntfy.sh (public server)
- ✅ Self-hosted ntfy instances
- ✅ Compatible servers (ntfy protocol)

## Maintenance

### Logging

All logs prefixed with `[ntfy]` for easy filtering:

```bash
pi ... 2>&1 | grep '\[ntfy\]'
```

### Debugging

Enable verbose logging by setting:
```bash
export DEBUG=ntfy:*
```

### Versioning

Follow semantic versioning:
- **Major**: Breaking config changes
- **Minor**: New features (notifications, tools)
- **Patch**: Bug fixes, performance improvements

## References

- [pi Extension Documentation](../docs/extensions.md)
- [ntfy Protocol](https://ntfy.sh/publish/)
- [ntfy API](https://ntfy.sh/publish/#api)
- [TypeBox](https://github.com/sinclairzx81/typebox)
