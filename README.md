# VAULT RUSH

VAULT RUSH is a two-player, server-authoritative heist duel. It uses Node.js, Express, and `ws`; the browser client is a single HTML file with inline CSS and JavaScript.

## Run locally

Requires Node.js 18 or later.

1. Save the files using the structure shown above.
2. From the project root, run:

   ```sh
   npm install
   npm start
   ```

3. Open `http://localhost:3000` in two browser tabs or devices.
4. Create a room in one tab. Enter the four-letter code in the other, or use the invite link.
5. Check `http://localhost:3000/health` for the service health response.

## Rules

- The game has two players, six rounds, and a 3×3 vault grid.
- Every board has one vault worth 1 and one worth 5. The other seven vaults are worth 2–4.
- The Thief and Guard secretly choose one vault each. Both picks reveal together.
- A matching pick catches the Thief: the Thief gets 0 and the Guard gets 2.
- If picks differ, the Thief steals the loot value on the chosen vault.
- Roles alternate each round.
- Each player can use one power during the game:
  - **Ghost:** if the Thief targets the top-value vault, the Guard cannot catch that pick, even if they choose that same vault.
  - **Lockdown:** if the Thief targets a vault worth 4 or 5, the Thief receives half the loot, rounded down, even if the Guard picked the same vault. The Guard gets no catch bonus for that round.
- The higher total after six rounds wins. A tie starts sudden death; sudden death repeats if the scores remain tied.

## Deploy to Render from GitHub

Render currently accepts inbound WebSocket connections on web services. Its Free web services can spin down after 15 minutes without inbound traffic and may take about a minute to wake. Free instances run a single instance and have an ephemeral filesystem, so this in-memory game loses rooms if the service restarts or spins down. These limits make Free suitable for a competition demo, but not durable production hosting. See [Render Free services](https://render.com/docs/free) and [Render WebSockets](https://render.com/docs/websocket).

1. Create a GitHub repository named `vault-rush`.
2. Add the files from this project at the repository root:
   - `package.json`
   - `server.js`
   - `public/index.html`
   - `README.md`
3. Commit the files to the `main` branch.
4. In Render, choose **New → Web Service**.
5. Connect your GitHub account if prompted, select the `vault-rush` repository, then click **Connect**.
6. Enter these service settings:
   - **Name:** `vault-rush`
   - **Region:** choose the region closest to your players
   - **Branch:** `main`
   - **Root Directory:** leave blank
   - **Runtime / Language:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`
7. In **Advanced**, set **Health Check Path** to `/health`.
8. Do not add environment variables; the service reads the port from Render's `PORT` environment variable.
9. Click **Create Web Service** and wait for the first deploy to finish.
10. Open the generated `https://<your-service-name>.onrender.com` address. The client selects `wss://` automatically on HTTPS. Test the health endpoint at `https://<your-service-name>.onrender.com/health`.

Render deploys web services from a Git repository with the configured build and start commands. See [Render web services](https://render.com/docs/web-services).

## Operational notes

- Room state, scores, picks, and reconnect tokens are held in server memory. A process restart clears active rooms.
- Keep this service at one instance. The free plan is single-instance; multiple instances would need shared room storage.
- The server sends WebSocket ping frames every 20 seconds. The browser also sends a small heartbeat message every 20 seconds.
- A disconnected player can reclaim their seat for 30 seconds. The match clock pauses while either player is disconnected.
- No user account or database is required.

## 2-device test checklist

- [ ] Create a room on device A and join by code on device B.
- [ ] Open the copied invite link on another browser and confirm the room joins.
- [ ] Enter an invalid code and confirm the error is clear.
- [ ] Try a third browser in an occupied room and confirm it is rejected politely.
- [ ] Complete the tutorial, ready both players, and confirm roles alternate.
- [ ] Make matching picks and confirm only the Guard gets +2.
- [ ] Make different picks and confirm the Thief gets that vault's loot.
- [ ] Use Ghost on the 5 vault and verify a same-vault pick does not catch the Thief.
- [ ] Use Lockdown on a 4 or 5 vault and verify the Thief receives floor(value ÷ 2).
- [ ] Let a pick timer expire and confirm a random pick is made.
- [ ] Refresh during a round and verify the stored token rejoins the same player.
- [ ] Disconnect a player, reconnect within 30 seconds, then repeat with the window expired.
- [ ] Play through six rounds, confirm a tie enters sudden death, then request a rematch from both devices.

## 30-second competition pitch

VAULT RUSH is a two-player heist duel where both players choose in secret and reveal at the same time. One player steals from a neon-lit 3×3 vault grid while the other tries to predict and catch them. Six rounds, alternating roles, a 15-second decision clock, and one tactical power per player turn every choice into a bluff. A cinematic reveal, synth soundscape, and sudden-death finish make every match feel like a high-stakes break-in.

## Five quick customization tweaks

1. **Colors:** edit the CSS variables at the top of `public/index.html`, especially `--cyan`, `--magenta`, `--gold`, and `--bg`.
2. **Round count:** change the `6` round checks in `server.js`, then update the visible round labels and rules text in `public/index.html` and this README.
3. **Pick timer:** change `PICK_SECONDS` in `server.js`; update the client countdown fraction and visible instructions in `public/index.html`.
4. **Reveal pacing:** adjust `REVEAL_MS` and `SCOREBOARD_MS` in `server.js`.
5. **Loot distribution:** update `randomBoard()` in `server.js`. Keep all scoring server-side.