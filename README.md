# Vault (Cloudflare edition)

Vault is a personal collection catalog for board games, movies, TV series and anything else you collect. It runs on your free Cloudflare account. You open it in a browser on any computer or phone, and only you can sign in.

- **Pages and server:** a Cloudflare Worker named `vault` (`src/worker.js` and the `public/` folder)
- **Database:** Cloudflare D1, named `vault-db`
- **Images:** Cloudflare R2, a bucket named `vault-media`
- **Sign-in:** Cloudflare Access, with a one-time code emailed to you
- **Code:** a private GitHub repository. Cloudflare redeploys Vault automatically whenever it changes.

---

## One-time setup (about 30 minutes)

Do the steps in order. You'll copy three values along the way: a **database ID**, a **team domain** and an **AUD tag**.

### Step 1: Create the database (D1)

1. Sign in at https://dash.cloudflare.com.
2. In the left menu, open **Storage & databases → D1 SQL database**.
3. Click **Create database**, name it exactly `vault-db`, and click **Create**.
4. On the database's page, copy the **Database ID**. It's a long string like `1a2b3c4d-....`.

### Step 2: Create the image storage (R2)

1. In the left menu, open **Storage & databases → R2 object storage**.
2. If this is your first time using R2, Cloudflare asks you to turn it on. It may ask for a card or PayPal to verify your account. The free allowance is 10 GB, far more than Vault needs, so a personal collection won't be charged.
3. Click **Create bucket**, name it exactly `vault-media`, leave the other options alone, and click **Create bucket**.

### Step 3: Put the database ID into Vault

1. In the Vault folder, open `wrangler.jsonc` with Notepad.
2. Replace `PASTE-DATABASE-ID-HERE` with the Database ID from Step 1. Keep the quote marks.
3. Save the file.

### Step 4: Upload Vault to GitHub

1. At https://github.com, click **New repository**.
2. Name it `vault`, choose **Private**, and click **Create repository**. Don't add a README.
3. On the new, empty repository page, find the small line of text under the HTTPS/SSH box that reads "Get started by creating a new file or **uploading an existing file**", and click **uploading an existing file**. It's easy to miss. You can also go straight to `https://github.com/YOUR-USERNAME/vault/upload/main`, putting your GitHub username in place of YOUR-USERNAME.
4. Open the Vault folder in File Explorer, select **everything inside it** (`public`, `src`, `package.json`, `wrangler.jsonc`, `README.md`, `.gitignore`), and drag it onto the GitHub page. Leave out the `_old-python-version` folder and any `.zip` files.
5. Wait for the uploads to finish, then click **Commit changes**.

### Step 5: Connect GitHub to Cloudflare

1. In Cloudflare, open **Workers & Pages** and click **Create**.
2. Choose **Import a repository** (the "Continue with GitHub" option). Allow Cloudflare to see your `vault` repository when GitHub asks.
3. Select the `vault` repository.
4. Make sure the project name is exactly `vault`. Leave the build command empty, and leave the deploy command as `npx wrangler deploy`.
5. Click **Create and deploy** (or **Deploy**) and wait a minute or two for it to finish.
6. When it's done, Cloudflare shows your address, something like `https://vault.yourname.workers.dev`. If you open it now, Vault shows an "Almost there" page. That's expected, because the sign-in isn't connected yet.

### Step 6: Turn on the sign-in (Cloudflare Access)

1. In **Workers & Pages**, click **vault**, then go to **Settings → Domains & Routes**.
2. Next to the `workers.dev` address, click **Enable Cloudflare Access**. If Cloudflare asks you to set up Zero Trust first, pick a team name and choose the **Free** plan.
3. A box appears showing two values. Copy both:
   - **Team domain**, like `https://yourteam.cloudflareaccess.com`
   - **AUD tag**, a long string of letters and numbers
4. Click **Manage Cloudflare Access** and check that the policy allows **your email address**. Add it if it isn't listed. Only the addresses listed there can get in.

### Step 7: Put the sign-in values into Vault

1. On GitHub, open your `vault` repository and click `wrangler.jsonc`.
2. Click the pencil icon (**Edit this file**).
3. Fill in the two empty values:

   ```
   "ACCESS_TEAM": "https://yourteam.cloudflareaccess.com",
   "ACCESS_AUD": "paste-the-AUD-tag-here"
   ```

4. Click **Commit changes**. Cloudflare redeploys automatically, which takes about a minute.

### Step 8: Open Vault

1. Go to your `workers.dev` address.
2. Enter your email address, then type the code Cloudflare emails you.
3. Vault opens. Go to **Settings → Sources** and paste your BoardGameGeek token, TMDB key and Watchmode key whenever you have them. Click **Save**, then **Test connection** on each.

On your phone, open the same address, sign in, and use **Add to Home Screen** so Vault opens like an app. The barcode button uses the phone's camera; allow camera access the first time you use it.

---

## Everyday notes

- **Nothing to install anywhere.** Any computer or phone with a browser works.
- **Staying signed in:** Cloudflare remembers you on each device for a while, then emails a fresh code.
- **Backups:** **Settings → Backup → Download backup** saves everything (data and images) as one .zip. Keep a copy in OneDrive. **Restore** puts a backup back.
- **Updates:** when Vault's code changes, open your repository on GitHub and click the **Add file** button. It sits just above the file list, to the left of the green **Code** button. Choose **Upload files**, drag in the updated `public` and `src` folders from your Vault folder, and click **Commit changes**. Files with the same names are replaced. Cloudflare redeploys automatically in a minute or two.
- **Where to watch:** each movie and TV page shows where it can be streamed free, with direct links where Watchmode has them (Pluto TV, Tubi and others) and "with ads" notes from JustWatch via TMDB. Older public-domain films can play right in Vault from the Internet Archive. Under the services, the **Search for it on** buttons open each service's own search for the title: Pluto TV, Tubi, The Roku Channel, Plex, Hoopla and YouTube. A free service with no direct link goes to that service's own search rather than to JustWatch. The **Watchlist** status is for free titles you don't own.
- **Watchmode's free allowance:** 2,500 credits a month, and each title check uses 2. Vault stops at 2,400 credits, checks a title only when you open its page (at most once a month per title) or click **Check again**, and shows this month's count in **Settings → Sources**. If the allowance runs out, the JustWatch results still show.
- **Free-tier limits** (100,000 requests a day, 5 GB database, 10 GB images) are far beyond what a personal collection uses.

## If something goes wrong

- **"Almost there" page:** `ACCESS_TEAM` or `ACCESS_AUD` is empty or wasn't saved. Recheck Step 7.
- **"Vault couldn't confirm your sign-in":** the AUD tag or team domain doesn't match. Copy them again from **Settings → Domains & Routes → Cloudflare Access**.
- **The deploy fails with a database error:** the Database ID in `wrangler.jsonc` doesn't match, or the database isn't named `vault-db`.
- **Images don't save:** check that the R2 bucket is named exactly `vault-media`.

## Credits

Board game data is powered by BGG (BoardGameGeek). This product uses the TMDB API but is not endorsed or certified by TMDB. Free-streaming data comes from JustWatch (through TMDB) and Watchmode. Public-domain films come from the Internet Archive. Barcode lookups come from UPCitemdb. Barcode reading uses zxing-wasm (MIT), and zip files use JSZip (MIT). Their license files are in `public/vendor`.
