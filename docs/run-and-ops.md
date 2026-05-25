# Run and ops

How to run the daemon under a process supervisor and rotate its logs.

## Prereqs

- Node.js 20+
- `accounts.json` populated (see `accounts.example.json`)
- `.env` populated (see `.env.example`)
- `akash-deploy.yaml` present at project root

## Quick local run

```bash
npm install
npm run probe            # one-time, validates account + locks schema
npm run check-proxy      # confirms outbound IP per account
npm start                # foreground daemon
```

Logs are appended to `./logs/akash-bidding.log` (JSONL). Tail with:

```bash
tail -f logs/akash-bidding.log | jq .
```

## PM2

```bash
npm install -g pm2 pm2-logrotate
pm2 start src/index.js --name akash-bidder \
  --log ./logs/pm2.log \
  --time \
  --max-memory-restart 300M
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 14
pm2 save
pm2 startup            # follow printed instruction for boot persistence
```

Useful commands:

```bash
pm2 logs akash-bidder
pm2 restart akash-bidder
pm2 stop akash-bidder
pm2 delete akash-bidder
```

## systemd (user unit)

`~/.config/systemd/user/akash-bidder.service`:

```ini
[Unit]
Description=Akash GPU auto-bidding daemon
After=network-online.target

[Service]
WorkingDirectory=%h/akash-bidding
ExecStart=/usr/bin/env node src/index.js
Restart=on-failure
RestartSec=10
StandardOutput=append:%h/akash-bidding/logs/systemd.log
StandardError=append:%h/akash-bidding/logs/systemd.log

[Install]
WantedBy=default.target
```

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now akash-bidder
journalctl --user -u akash-bidder -f
```

## logrotate

`/etc/logrotate.d/akash-bidder`:

```
/home/USER/akash-bidding/logs/akash-bidding.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
    copytruncate
}
```

## Restart-after-crash policy

The daemon exits 0 on the all-accounts-depleted condition (Telegram is sent) — PM2/systemd should NOT restart in that case (zero exit). On `uncaughtException` it exits 1 and a Telegram crash message is sent; PM2/systemd will restart automatically.

### What is NOT restored after restart

- Round-robin cursor → resets to 0
- Exhausted-set → cleared (balance is re-checked from scratch per account)
- Active deployments → not tracked; Akash will auto-evict them when deposit drains

This is intentional: v1 has no persistence layer.

## Troubleshooting

- **No bids matching for hours** → `MAX_UACT_PER_BLOCK` likely too low. Inspect a recent bid via `npm run probe` and raise the cap.
- **Account marked exhausted after `no matching bids in 10 cycles`** → bump `NO_MATCH_EXHAUST_THRESHOLD` or relax filters; account is otherwise healthy.
- **`proxy.fallback` warnings in logs** → proxy is dead; daemon continues via direct fetch. Replace the proxy URL when convenient.
