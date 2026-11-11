# ArugoBot on Oracle Cloud Always Free

Run one Ubuntu 24.04 VM with a persistent boot disk and a systemd service.
The bot makes outbound connections to Discord and Codeforces; it does not need
a domain, web server, or inbound application port.

This setup installs upstream commit
`6848332333bef2384d28ca90bce229d913d84da6` without changing the bot's Python code.
It uses Python 3.12, the repository's pinned dependencies, and direct Codeforces
requests. The current code works without a proxies file.

## 1. Create the Oracle account and VM

Sign up through [Oracle Cloud Free Tier](https://www.oracle.com/cloud/free/).
Signup usually requires a phone number and a credit/debit card for verification.
Oracle may place a temporary authorization hold. Stay on the Free Tier account;
upgrading to Pay As You Go permits billable usage.

Choose your **home region** carefully: it cannot be changed, and Always Free
compute and boot storage must be created there. Choose a supported region near
you, then check the account's actual free limits in **Limits, Quotas and Usage**.

In **Compute → Instances → Create instance**, use:

| Setting | Value |
| --- | --- |
| Name | `arugobot` |
| Image | Canonical Ubuntu **24.04**, standard or Minimal |
| Shape | `VM.Standard.A1.Flex` (Ampere/Arm) |
| OCPUs | **1** |
| Memory | **2 GB** |
| Boot volume | **50 GB**, default performance |
| Region | Your account's **home region** |
| Network | Public subnet with an internet gateway |
| Public IPv4 | Assign one |
| SSH keys | Upload your public key, or generate and download a key pair |

Choose an Ubuntu image compatible with the selected Arm shape. The creation form
filters compatible images; do not use an x86-only image for A1.

Oracle's current resource documentation lists **1,500 A1 OCPU-hours and 9,000 GB
memory-hours per month** (equivalent to 2 OCPUs and 12 GB), **200 GB of combined
boot/block storage**, and **five volume backups**. The VM above is below those
limits, assuming your other resources do not consume the allowance. Older guides
may quote different A1 limits; confirm the current values in your tenancy.

If A1 reports **out of host capacity**, try another availability domain in the
same home region or retry later. An alternative is an Always Free
`VM.Standard.E2.1.Micro` with **1 GB RAM** and an x86 Ubuntu 24.04 image; it has
less CPU capacity. The same installer works on either architecture. Other shapes
can consume trial credits and cease to be free after the trial.

For networking:

- Use an internet gateway and a public-subnet route of `0.0.0.0/0` to it.
- Allow inbound TCP **22** from your own public IP (`YOUR_IP/32`) for SSH.
- The default outbound rules allow DNS and HTTPS/WebSocket connections required
  by the bot. If you restrict egress, retain DNS and TCP 443.
- Keep the public IP and SSH private key available locally. The private key
  should not be uploaded to the repository or sent in chat.

Oracle's instance creation form can create the VCN and public subnet. If you
create them separately, verify the route and security rules above.

## 2. Create your Discord application

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Create an application and open its **Bot** settings.
2. Generate the bot token and keep it for the private prompt in step 4.
3. Enable **Message Content Intent**, which is required for commands such as
   `=register` and `=challenge`.
4. Generate a server install link with the `bot` scope and these permissions:
   View Channels, Send Messages, Embed Links, Attach Files, Read Message History,
   and Add Reactions. Invite it to your server.

Check channel-level permission overrides as well. The bot uses reactions for
confirmation and fetches its previous messages to update challenge results.

## 3. Copy the deployment files to the VM

Run these commands on your Mac from the local ArugoBot checkout. Replace the
key path and example IP with the values for your VM:

```bash
ARUGOBOT_SSH_KEY="/absolute/path/to/your-oracle-private-key.key"
ARUGOBOT_IP="203.0.113.10"
chmod 600 "$ARUGOBOT_SSH_KEY"

ssh -i "$ARUGOBOT_SSH_KEY" "ubuntu@$ARUGOBOT_IP" \
  'mkdir -p /home/ubuntu/arugobot-oracle'

scp -i "$ARUGOBOT_SSH_KEY" \
  deploy/oracle/install.sh \
  deploy/oracle/arugobot.service \
  deploy/oracle/arugobot.logrotate \
  deploy/oracle/README.md \
  "ubuntu@$ARUGOBOT_IP:arugobot-oracle/"

ssh -i "$ARUGOBOT_SSH_KEY" "ubuntu@$ARUGOBOT_IP"
```

You are now in a shell on the VM. Run:

```bash
bash /home/ubuntu/arugobot-oracle/install.sh
```

The installer checks the OS and login user, installs Python and SQLite tools,
clones the pinned upstream revision into `/home/ubuntu/ArugoBot`, installs
dependencies into a virtual environment, and installs the service and log
rotation. It uses `sudo` for system packages and systemd configuration. On a
standard OCI Ubuntu image, the `ubuntu` user's sudo access is already configured.

The installer can be rerun while the bot is stopped if its source is still at
the pinned revision with no tracked modifications. It preserves the token and
database. It does not start the bot.

## 4. Add the token and start the bot

Run this **inside the SSH session**. Type or paste the bot token at the hidden
prompt. The token does not appear in the command or shell history:

```bash
umask 077
read -r -s -p 'Discord bot token: ' ARUGOBOT_TOKEN
printf '\n'
if [ -n "$ARUGOBOT_TOKEN" ]; then
  printf '%s\n' "$ARUGOBOT_TOKEN" > /home/ubuntu/ArugoBot/token.txt
  chmod 600 /home/ubuntu/ArugoBot/token.txt
else
  printf 'No token entered; token file was not changed.\n'
fi
unset ARUGOBOT_TOKEN

sudo systemctl enable --now arugobot
sudo systemctl status arugobot --no-pager
sudo journalctl -u arugobot -n 80 --no-pager
```

Look for successful command loading, `Logged in as ...`, and `Data parsing
complete.` The last message confirms the bot loaded Codeforces data from this
VM. A successful Discord login alone does not verify Codeforces connectivity.

In a permitted Discord channel, try `=ping` and `=help`, then register your
Codeforces handle and test `=rating` and a challenge. If they work, you can close
SSH; systemd keeps the bot running and starts it after VM reboots.

## Operation and backups

Useful commands on the VM:

```bash
sudo journalctl -u arugobot -f
sudo systemctl restart arugobot
sudo systemctl stop arugobot
```

The database is `/home/ubuntu/ArugoBot/bot_data.db`. It survives service restarts
and VM reboots on the same boot volume. **Active challenges live in memory and
do not resume after a restart**, so schedule maintenance between challenges.
The file log is rotated to avoid indefinite growth.

Keep a database backup outside the VM. Run these commands on your Mac from the
same shell where you set the SSH variables:

```bash
ssh -i "$ARUGOBOT_SSH_KEY" "ubuntu@$ARUGOBOT_IP" \
  'umask 077; sqlite3 /home/ubuntu/ArugoBot/bot_data.db ".backup /home/ubuntu/arugobot-backup.db"'
scp -i "$ARUGOBOT_SSH_KEY" \
  "ubuntu@$ARUGOBOT_IP:arugobot-backup.db" ./arugobot-backup.db
```

SQLite's `.backup` command makes a consistent snapshot while the bot runs.
To restore a backup, stop the service, replace the database as the `ubuntu`
user, and start the service. Keep the token separately and do not publish
database backups, which contain users' Discord IDs and Codeforces handles.

## If something fails

- **SSH times out:** check the public IP, internet gateway route, and TCP 22
  ingress rule. If your home IP changed, update its `/32` rule.
- **SSH permission denied:** use the matching private key and username `ubuntu`.
- **Service skipped:** the token file is absent or empty. Repeat step 4.
- **Discord rejects login or privileged intents:** check the bot token and
  Message Content Intent in the Developer Portal.
- **Codeforces errors:** inspect the journal for the HTTP/API error. The VM
  needs working outbound access to Codeforces; a datacenter IP might be
  restricted or the API might be unavailable. This needs verification from the
  actual VM. Changing the Discord token will not fix it.
- **Service stopped after repeated failures:** fix the logged error, then run
  `sudo systemctl reset-failed arugobot` and `sudo systemctl start arugobot`.

Oracle can reclaim **idle** Always Free instances. Its current policy considers
CPU and network utilization over seven days, plus memory for A1. A lightly used
bot may qualify, so free hosting does not guarantee uninterrupted availability.
Keep the external database backup and this deployment setup for recovery.

## References and validation

- [Always Free resources, limits, capacity and idle reclamation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [Free Tier and trial expiry](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm)
- [Account signup and card verification](https://docs.oracle.com/en-us/iaas/Content/GSG/Tasks/signingup_topic-Sign_Up_for_Free_Oracle_Cloud_Promotion.htm)
- [Creating an instance](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/launchinginstance.htm)
- [Public IP and internet connectivity requirements](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingpublicIPs.htm)
- [Ubuntu 24.04 platform images](https://docs.oracle.com/en-us/iaas/images/ubuntu-2404/)

Local checks completed:

- Bash syntax and ShellCheck pass for the installer.
- The installer rejects macOS before attempting any system changes.
- All 11 Python source files parse with Python 3.12.
- Pip resolves every pinned dependency to prebuilt Python 3.12 Linux wheels for
  both Arm64 and AMD64, avoiding compilation on the small VM.

The systemd service and live Discord/Codeforces connections have not been tested
on an Oracle instance. A full deployment still requires an Oracle account, a
running VM, and your Discord bot token; the local preparation does not create
any Oracle resources. The installer runs `systemd-analyze verify` on the VM
as part of setup.
