# Use Discord instead of Slack (experimental)

> **Experimental.** The Discord connector reaches the person through a private Discord server
> instead of Slack. It behaves as the Slack connector does and replaces it on a machine: one chat
> connector runs at a time. If a step here doesn't match what Discord shows you, please
> [open an issue](https://github.com/mvschwarz/openrig/issues/new/choose).

The Discord connector runs in the daemon's gateway, like the Slack one, with Discord's REST API
and Gateway (WebSocket) in place of Slack's Web API and Socket Mode. Everything above the
transport is the Slack connector's: delivery classes, modes and quiet windows, digests and
deferrals, thread routing, missed-reply recovery and ask settlement. The Gateway is an outbound
connection, so the host needs no inbound route.

## What the person sees

- **An ask** is one message: who is asking, the headline with an @-mention, and one row of
  buttons per question. The recommended option is the green button labelled "(recommended)". The
  why and the evidence are in a thread started from that message. A tap on a button, or a reply
  in the thread, reaches the seat that asked.
- **An update** is one message, with no buttons and no thread (a long one continues in a thread).
- **A post outside any thread** reaches the inbound destination (the kernel operator by default).
- Posts by bots and webhooks are ignored, OpenRig's own included.
- When an ask is settled, its message is edited: the outcome on top, the buttons kept but
  disabled.

## Create the Discord application

1. Create a server for OpenRig whose only human member is you. Server membership is the privacy
   boundary: anyone in the server can read the channel.
2. At <https://discord.com/developers/applications>, create an application and add a **Bot**.
   Copy the bot token.
3. Under **Bot → Privileged Gateway Intents**, turn on **Message Content**. Without it OpenRig
   can't read what you write. A bot in fewer than 100 servers can turn this on itself.
4. Under **General Information**, leave **Interactions Endpoint URL** empty. If it's set, Discord
   sends every button tap there instead of over the Gateway, and taps never reach OpenRig.
5. Invite the bot to the server (OAuth2 → URL Generator, scope `bot`) with **View Channels**,
   **Send Messages**, **Create Public Threads**, **Send Messages in Threads**, **Read Message
   History** and **Attach Files**.
6. In Discord, turn on **User Settings → Advanced → Developer Mode**, then right-click to copy the
   channel's id and your own user id.

## Connect OpenRig

Put the token in a 0600 env file, never in the config:

```bash
printf 'DISCORD_BOT_TOKEN=%s\n' '<token>' > ~/.openrig/discord.env && chmod 600 ~/.openrig/discord.env
```

Then:

```bash
rig discord setup --channel <channel id> --user <your user id> --secrets-env-file ~/.openrig/discord.env
rig discord verify      # token, Message Content intent, no Interactions Endpoint URL, channel, you in the server
rig slack disable --reason "moving to Discord"   # only if Slack is enabled
rig discord enable
rig discord status
```

`--user` makes your Discord user id your registered person's primary binding (`kind: discord`),
so OpenRig @-mentions you and recognises your posts. With more than one person registered, name
one with `--person <entityId>`. `rig discord enable`, like `rig slack enable`, marks the asks
already waiting as seen so they don't all post at once; `rig discord post-open-asks` shows the
ones still open.

## How it maps to Slack

| Slack | Discord |
|---|---|
| Channel | Channel in your private server |
| Thread under a message | Thread started from that message (created on the first reply) |
| Message `ts` | The message's snowflake id; OpenRig keeps a durable map in `state/discord-ids.jsonl` |
| Block Kit buttons | Button rows (at most 4 questions of 2–4 options) |
| Socket Mode | The Gateway, with heartbeat, resume and reconnect |
| `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` | `DISCORD_BOT_TOKEN` alone |

The connector shares the gateway's state files (`state/slack-*.jsonl`), so posts already made
through Slack aren't made again after the switch. Threads started in Slack stay there: recovery
only scans the Discord channels configured, and an update replying to a Slack-era thread posts as a
new message in Discord. A Discord inline reply (the Reply action) in the channel is a post outside
any thread, as a Slack channel message is; to answer an ask, reply in its thread.

## Not offered on Discord

The named-bot inbox, forwarding one app's channels between machines, shared channels and the
Slack directory pickers are Slack-only. A `discord-connector.json` naming `botInbox` or
`forwardChannels` is refused on save, and `rig discord status` names them if they're present.
