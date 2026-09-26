/**
 * The admin dashboard manual, seeded as FAQ entries.
 *
 * One entry per thing an admin can actually do, written as steps rather than
 * description — the test of an entry is whether someone who has never opened
 * the panel could follow it and finish the task. Every "Go to X" now links
 * straight to that page (and, where the page has its own sub-navigation,
 * straight to the right section of it) — see the route map in a comment
 * at the bottom of this file if a link ever needs updating.
 *
 * `roleNote` marks an action a lower admin cannot complete. It is set from the
 * real guards in the controllers, not from intent: every value here corresponds
 * to a `req.user.role !== 'super_admin'` check that exists in the code. If a
 * guard is added or removed, the matching note here should move with it.
 */

const ADMIN_FAQ_SEED = [
  // ── Getting around ────────────────────────────────────────────────────────
  {
    question: 'How do I find a setting quickly?',
    answer: '<p>Use the search box directly under the logo in the left sidebar. It filters the whole menu as you type and matches more than the visible page name — searching <strong>commission</strong> finds <em>Growth &amp; Rewards</em>, and <strong>refund</strong> finds <em>Flagged Transactions</em>.</p><p>Press <strong>/</strong> anywhere to jump into the search box, <strong>Enter</strong> to open the first match, and <strong>Esc</strong> to clear it.</p>',
    order: 1,
  },
  {
    question: 'What is the second sidebar on some pages?',
    answer: '<p>Pages with several groups of settings show a secondary drawer on the left of the content area. Each entry opens a section of that page without a reload, and your choice is remembered — reloading or sharing the link brings you back to the same section, because the section is written into the URL after the <strong>#</strong>. That means you can bookmark or send a colleague a link straight to, say, <a href="/admin/settings#maintenance"><strong>Site Settings &rarr; Maintenance</strong></a> rather than telling them where to click once they arrive.</p><p>The page title is the name of the panel; the line under it tells you which section you are currently in.</p>',
    order: 2,
  },

  // ── Users ─────────────────────────────────────────────────────────────────
  {
    question: 'How do I look up a user and see their full history?',
    answer: '<p>Go to <a href="/admin/product/view-users"><strong>Users &rarr; All Users</strong></a> and search by username, email, or phone number. Click the user to open their details page, which shows their wallet balances, transactions, top-ups, reward points, and referral activity in one place.</p>',
    order: 10,
  },
  {
    question: 'How do I credit or debit a user\'s wallet manually?',
    answer: '<p>Open the user from <a href="/admin/product/view-users"><strong>Users &rarr; All Users</strong></a>, then use the wallet controls on their details page. Enter the amount and a reason — the reason is written into the audit trail, so state what the adjustment is for.</p><p>Every manual adjustment records the balance before and after, who made it, and when. It cannot be edited afterwards; a mistake is corrected with a second, opposite adjustment so both movements stay visible.</p>',
    order: 11,
  },
  {
    question: 'How do I see who referred a user, and who they referred?',
    answer: '<p>Open the user from <a href="/admin/product/view-users"><strong>Users &rarr; All Users</strong></a> and scroll to the <strong>Referrals</strong> section. It shows their own referral code, who referred them, everyone they have referred, and the reward and commission paid on each — including any past codes they used to own, which stay valid permanently.</p><p>A referral shown as <strong>pending</strong> has not paid out yet — see the next entry for exactly what unlocks it.</p>',
    order: 12,
  },
  {
    question: 'A referral has stayed "pending" for a while. Is that a bug?',
    answer: '<p>Usually not. A referral only turns into a reward once the referred person completes enough purchases — the number is set on <a href="/admin/referrals#reward"><strong>Growth &amp; Rewards &rarr; Reward</strong></a> as <strong>Purchases required</strong>, and it is a count of orders, not a spend amount, so it means the same thing in every currency the store sells in.</p><p>If a referred user has verified their account but never actually bought anything, their referral will sit at <strong>pending</strong> indefinitely — that is correct, not stuck. It moves to <strong>rewarded</strong> automatically the moment they cross the purchase count, with no admin action needed. Check the referred user\'s own purchase count on their <a href="/admin/product/view-users"><strong>user details page</strong></a> before assuming anything is broken.</p>',
    order: 13,
  },
  {
    question: 'Why do referral rewards say "Locked" / "Unlocked" instead of "Claim"?',
    answer: '<p>A referral reward is never claimed by hand — it is paid into the referrer\'s wallet automatically the instant it qualifies. <strong>Unlocked</strong> means it has already been paid; <strong>Locked</strong> means it is earned but waiting on the referred person to finish qualifying (see the previous entry). There is deliberately no claim button, because there is nothing for the referrer to do.</p><p>Each locked/unlocked card on a user\'s own <strong>Referrals</strong> page has a small info button explaining this in plain language, so you can point a confused user at it instead of re-explaining it yourself.</p>',
    order: 14,
  },

  // ── Admin accounts ────────────────────────────────────────────────────────
  {
    question: 'How do I add a new admin?',
    answer: '<p>Go to <a href="/admin/admins"><strong>Users &rarr; Admins</strong></a> and use <strong>Add Admin</strong>. Enter their username, email, and role. They receive their sign-in details by email and are asked to complete their profile on first login.</p><p>Choose the lowest role that lets them do their job — roles can be raised later without recreating the account.</p>',
    roleNote: 'super_admin',
    order: 20,
  },
  {
    question: 'What can each admin role do?',
    answer: '<p>There are three roles:</p><ul><li><strong>Junior admin</strong> — day-to-day work: viewing users, processing top-ups, handling transactions.</li><li><strong>Senior admin</strong> — the same, plus product, pricing, and configuration changes.</li><li><strong>Super admin</strong> — everything, plus the actions no one else can take: managing admin accounts and roles, approving refunds and password resets, editing this manual, and managing the testers list.</li></ul><p>Any action restricted to a single role is marked with a note on its entry in this manual, and the role you must pick to sign in is a dropdown right on the <a href="/command">sign-in page</a> itself — picking the wrong one there reads as an "incorrect role" error even with the right password.</p>',
    order: 21,
  },
  {
    question: 'How do I change an admin\'s role, deactivate them, or remove them?',
    answer: '<p>Go to <a href="/admin/admins"><strong>Users &rarr; Admins</strong></a> and use the controls on that admin\'s row. Deactivating keeps the account and its history but blocks sign-in, and takes effect within five minutes even if they are already signed in. Deleting removes the account entirely.</p><p>Prefer deactivating over deleting — it is reversible, and it keeps their name attached to the actions they took.</p>',
    roleNote: 'super_admin',
    order: 22,
  },
  {
    question: 'An admin cannot receive their two-factor code. How do I get them back in?',
    answer: '<p>Go to <a href="/admin/admins"><strong>Users &rarr; Admins</strong></a> and turn off two-factor for that admin. This is the deliberate escape hatch for a broken inbox. The panel records who granted the exemption and when, because removing a second factor is a security decision.</p><p>Turn it back on once their email is working. Note that two-factor cannot be removed from another super admin.</p>',
    roleNote: 'super_admin',
    order: 23,
  },
  {
    question: 'How do I approve a user\'s password reset request?',
    answer: '<p>Pending reset requests appear under <a href="/admin/product/view-users"><strong>Users</strong></a>. Open the request, confirm the user is who they say they are through a channel other than the email on the account, then approve it. The user is emailed a link to set a new password.</p>',
    roleNote: 'super_admin',
    order: 24,
  },

  // ── Products ──────────────────────────────────────────────────────────────
  {
    question: 'How do I add a new product?',
    answer: '<p>Go to <a href="/admin/product/create-products"><strong>Products &rarr; Add Product</strong></a>. Pick the category, then fill in the fields that category asks for. Data bundles additionally need a network, a provider (OurDataStore or GSubz), and a plan chosen from the list you configured in <a href="/admin/networks"><strong>Products &rarr; Data Config</strong></a> — a data product can no longer be delivered without one.</p><p>Set the <strong>country</strong> before saving — it decides which shoppers can see and buy the product. A product left on the default is a Nigerian product.</p>',
    order: 30,
  },
  {
    question: 'How do I change a price, or take a product off sale?',
    answer: '<p>Go to <a href="/admin/product/view-products"><strong>Products &rarr; View Products</strong></a>, find the product, and click edit. Change the price and save; it applies to new purchases immediately.</p><p>To take something off sale without losing its history, switch it inactive rather than deleting it. Deleting hides it from past transactions too, which makes older orders harder to read.</p>',
    order: 31,
  },
  {
    question: 'What is the bonus field on a data product?',
    answer: '<p>The bonus is the extra value credited on top of the bundle a customer buys. Leave it empty or zero for no bonus.</p><p>It is saved per product, so changing it on one bundle does not affect the others — set it from the same edit screen under <a href="/admin/product/view-products"><strong>Products &rarr; View Products</strong></a>.</p>',
    order: 32,
  },
  {
    question: 'How do I manage data plans and their providers?',
    answer: '<p>Go to <a href="/admin/networks"><strong>Products &rarr; Data Config</strong></a>. It has a tab for each provider — OurDataStore and GSubz — and each configured plan holds the identifiers used when a bundle is sent to that provider. If a bundle is failing to deliver, check the plan/service ID here against the provider\'s own list on <a href="/admin/ourdatastore"><strong>Service Providers &rarr; OurDataStore</strong></a> (or the matching GSubz page) first — a wrong ID is the most common cause.</p>',
    order: 33,
  },
  {
    question: 'How do I add or reorder categories?',
    answer: '<p>Go to <a href="/admin/category/view-category"><strong>Products &rarr; Categories</strong></a>. Add, rename, or reorder from there; the order set here is the order shoppers see.</p>',
    order: 34,
  },

  // ── Transactions ──────────────────────────────────────────────────────────
  {
    question: 'How do I confirm a manual top-up?',
    answer: '<p>Go to <a href="/admin/product/view-topUps"><strong>Transactions &rarr; Top-Ups</strong></a>. Pending manual top-ups are listed with the amount and reference the user submitted. Verify the money actually arrived in the receiving account, then approve — approving credits the user\'s wallet immediately.</p><p>Always check the payment before approving. An approval is a real credit, and reversing it means a manual debit that the customer will see.</p>',
    order: 40,
  },
  {
    question: 'How do I find a specific transaction?',
    answer: '<p>Go to <a href="/admin/transactions"><strong>Transactions</strong></a> and filter by status, date range, or search the reference, username, or phone number. Each row opens to show the full record, including the wallet balance before and after and the provider\'s response.</p>',
    order: 41,
  },
  {
    question: 'What are flagged transactions, and what do the tabs mean?',
    answer: '<p><a href="/admin/flagged-transactions"><strong>Transactions &rarr; Flagged Transactions</strong></a> lists orders where what the customer received did not match what they paid for — usually a short delivery from the provider.</p><ul><li><strong>Deducted</strong> — the shortfall has been taken off the provider\'s account.</li><li><strong>Cleared</strong> — reviewed and found correct, no action needed.</li><li><strong>Refunded</strong> — the undelivered portion was credited back to the customer\'s wallet.</li></ul>',
    order: 42,
  },
  {
    question: 'How do I refund a customer for a short delivery?',
    answer: '<p>Open the flagged transaction under <a href="/admin/flagged-transactions"><strong>Transactions &rarr; Flagged Transactions</strong></a> and raise a refund request, stating what was short. A super admin then approves it, and the undelivered portion is credited to the customer\'s wallet. The customer is also notified in-app once it is done, explaining exactly how much of their original purchase was missing and what was credited.</p><p>Any admin can raise the request; only a super admin can approve it, so refunds always involve two people.</p>',
    order: 43,
  },
  {
    question: 'How do I approve a pending refund request?',
    answer: '<p>Open <a href="/admin/flagged-transactions"><strong>Transactions &rarr; Flagged Transactions</strong></a>, review the pending request against the provider\'s response on the original order, then approve or decline it. Approving credits the customer\'s wallet straight away.</p>',
    roleNote: 'super_admin',
    order: 44,
  },
  {
    question: 'Where do I see how much the business is actually making?',
    answer: '<p>Go to <a href="/admin/profit"><strong>Transactions &rarr; Profit Report</strong></a>. It shows revenue against provider cost over the period you choose, so you can see margin per product rather than just sales volume.</p>',
    order: 45,
  },

  // ── Payments & wallets ────────────────────────────────────────────────────
  {
    question: 'How do I open the store in a new country?',
    answer: '<p>Go to <a href="/admin/payments-wallets#markets"><strong>Transactions &rarr; Payments &amp; Wallets</strong></a> and add a wallet for that country. Creating the wallet is what makes the country live: users get a balance in its currency and can be shown its products.</p><p>Then add at least one payment method for it under the same page\'s <strong>Add</strong> section, otherwise shoppers there can browse but cannot pay. The panel warns you about any country in exactly that state under <strong>Issues</strong>.</p>',
    order: 50,
  },
  {
    question: 'How do I add a payment method for a country?',
    answer: '<p>Open <a href="/admin/payments-wallets#add"><strong>Transactions &rarr; Payments &amp; Wallets</strong></a>, select the country\'s wallet, and add the method with the account details a customer should pay into. A new country starts with manual funding — the customer pays out of band and an admin confirms it under <a href="/admin/product/view-topUps"><strong>Transactions &rarr; Top-Ups</strong></a>.</p>',
    order: 51,
  },
  {
    question: 'Why can I not delete a country wallet?',
    answer: '<p>A wallet cannot be removed while any user still holds money in that currency, because deleting it would strand their balance. <a href="/admin/payments-wallets#issues"><strong>Payments &amp; Wallets &rarr; Issues</strong></a> tells you how many holders there are.</p><p>If there are none and it still refuses, the wallet is Nigeria — the fallback market, which cannot be removed. Hide it from shoppers instead of deleting it.</p>',
    order: 52,
  },

  // ── Growth & rewards ──────────────────────────────────────────────────────
  {
    question: 'How do I turn the signup bonus on or off, and what can it require?',
    answer: '<p>Go to <a href="/admin/referrals#signup"><strong>Growth &amp; Rewards &rarr; Signup Bonus</strong></a>. Choose whether it pays reward points or money, set the amount, and switch it active.</p><p>Each requirement toggles independently, and the process list shown to the user only ever lists the ones you have switched on:</p><ul><li><strong>Email verification</strong></li><li><strong>WhatsApp verification</strong></li><li><strong>BitToken Miner ID</strong> — the user enters their Miner ID and it is checked against BitToken directly; off by default so turning it on mid-promotion cannot suddenly add an unfinished step for someone who had already completed everything.</li><li><strong>Referred users</strong> — how many people they must refer, each of whom must finish their own verification to count.</li></ul><p>It is paid when a new user finishes every requirement you have switched on, not at signup — signing up is free and unlimited, so paying before verification would let one person farm it with throwaway addresses. The banner nagging a user to finish is fully dynamic: it only ever asks for the steps you have actually turned on.</p>',
    order: 60,
  },
  {
    question: 'How do I set the referral reward and the ongoing commission?',
    answer: '<p>Both are under <a href="/admin/referrals#reward"><strong>Growth &amp; Rewards &rarr; Reward</strong></a> and <a href="/admin/referrals#comm"><strong>Growth &amp; Rewards &rarr; Commission</strong></a>. The <strong>reward</strong> is the one-off payment when a referred user qualifies — see <strong>Purchases required</strong> on the same Reward section for what "qualifies" means (a count of orders, not a Naira amount, so the same setting is fair across every currency the store sells in). The <strong>commission</strong> is a percentage of every purchase they make afterwards, once qualified.</p><p>Each has its own bonus setting, and the commission can be set to zero — that switches off ongoing earnings while keeping the one-off reward.</p>',
    order: 61,
  },
  {
    question: 'How do special and custom referral codes work?',
    answer: '<p>Under <a href="/admin/referrals#paid"><strong>Growth &amp; Rewards &rarr; Paid Codes</strong></a> you can put paid codes on sale and set a separate price, currency, and bonus for each kind:</p><ul><li><strong>Special</strong> — a code the user picks from a pool you have reserved, managed under <a href="/admin/referrals#reserved"><strong>Reserved Pool</strong></a>. Enter them in bulk, comma separated, using letters and numbers only.</li><li><strong>Custom</strong> — a code the user chooses themselves, checked for length and availability. It has the same settable currency dropdown as a special code, rather than defaulting to whatever wallet the buyer happens to be in.</li></ul><p>Requests need approving before payment goes through, which is what stops an offensive custom code going live — pending ones are listed under <a href="/admin/referrals#requests"><strong>Requests</strong></a>. Turn on auto-approve only if you are willing to give up that check.</p>',
    order: 62,
  },
  {
    question: 'If a user changes their referral code, do their old links stop working?',
    answer: '<p>No. Codes are kept in their own record with the user attached, so every code a user has ever held keeps resolving to them permanently. Old links and posts carry on working.</p><p>Their past codes are listed on their details page under <a href="/admin/product/view-users"><strong>Users &rarr; All Users</strong></a>, and on their own dashboard.</p>',
    order: 63,
  },
  {
    question: 'A referral was made, but the referrer never got paid — what should I check?',
    answer: '<p>First check the referred user\'s purchase count on their <a href="/admin/product/view-users"><strong>user details page</strong></a> against the current <strong>Purchases required</strong> figure on <a href="/admin/referrals#reward"><strong>Growth &amp; Rewards &rarr; Reward</strong></a> — a referral genuinely stays <strong>pending</strong>, by design, until that many orders are placed. It is not gated on email or WhatsApp verification at all; verification only ever gates the signup bonus.</p><p>If the count is already met and it is still pending, check <a href="/admin/referrals#overview"><strong>Growth &amp; Rewards &rarr; Overview</strong></a> for a per-referrer reward cap — once a referrer hits it, further qualifying referrals are marked <strong>void</strong> rather than paid, on purpose.</p>',
    order: 64,
  },

  // ── Announcements ─────────────────────────────────────────────────────────
  {
    question: 'How do I put a banner, strip, or popup on the site?',
    answer: '<p>Go to <a href="/admin/announcements"><strong>Configuration &rarr; Announcements</strong></a> and pick the surface:</p><ul><li><a href="/admin/announcements#banners"><strong>Banner</strong></a> — a slide in the home page hero.</li><li><a href="/admin/announcements#strips"><strong>Strip</strong></a> — a thin bar under the header.</li><li><a href="/admin/announcements#popups"><strong>Popup</strong></a> — a card shown to a signed-in user.</li></ul><p>Changes appear on the site within a minute.</p>',
    order: 70,
  },
  {
    question: 'How do I make an announcement expire on its own?',
    answer: '<p>Set a countdown end date on it, from the <a href="/admin/announcements#editor"><strong>Announcements &rarr; Editor</strong></a>. Once that moment passes the announcement stops rendering by itself, so a finished promotion does not need remembering to take down.</p><p>On a strip you can also put <strong>{countdown}</strong> in the text, and it is replaced with a live ticking timer.</p>',
    order: 71,
  },
  {
    question: 'How do the new-feature popups work?',
    answer: '<p>Several active popups become a stepped tour: a signed-in user sees the first, moves through with <strong>Next</strong>, and the set is marked seen when they finish or close it. Reorder them under <a href="/admin/announcements#popups"><strong>Announcements &rarr; Popups</strong></a> — the order field is the order they are shown in.</p><p>Deactivate one to drop it from the tour without deleting it.</p>',
    order: 72,
  },

  // ── This manual ───────────────────────────────────────────────────────────
  {
    question: 'How do I edit this admin manual?',
    answer: '<p>Go to <a href="/admin/faq#admin-manual"><strong>Configuration &rarr; FAQ Manager &rarr; Admin Dashboard</strong></a>. Entries here are only ever shown inside the panel — they never appear on the public FAQ page.</p><p>If an entry describes something only one role can do, set its <strong>Restricted to</strong> field so the restriction is visible on the entry itself. Writing a real link into an answer works exactly like writing one on the public FAQ — select the text in the editor and use its link button, then paste the page\'s own address (everything in this manual starts with <code>/admin/</code>).</p>',
    roleNote: 'super_admin',
    order: 80,
  },
  {
    question: 'How do I edit the FAQ that customers see?',
    answer: '<p><a href="/admin/faq"><strong>Configuration &rarr; FAQ Manager</strong></a>, in any section other than Admin Dashboard. Pick the category it belongs under, write the answer in the editor, and save. It appears on the public <a href="/faq">FAQ page</a> immediately.</p><p>Switch an entry inactive to pull it from the site while you rework it, rather than deleting it.</p>',
    order: 81,
  },

  // ── Support & testing ─────────────────────────────────────────────────────
  {
    question: 'I have found a bug. How do I report it?',
    answer: '<p>Go to <a href="/admin/support#create"><strong>Support and Testing &rarr; Create a Report</strong></a>. Give it a title, say whether it is on the client site or the admin dashboard, name the page, and assign it to whoever from <a href="/admin/support#developers"><strong>Developers</strong></a> should look at it.</p><p>Say what you did, what you expected, and what actually happened — a report that says only "it is broken" usually needs a second conversation before anyone can act on it. Submitting also emails the developer you assigned it to.</p>',
    order: 90,
  },
  {
    question: 'Where do I see the reports I have submitted?',
    answer: '<p><a href="/admin/support#reports"><strong>Support and Testing &rarr; Reports</strong></a> lists your own reports with the time you submitted each and its current status. A super admin sees every report along with who filed it.</p>',
    order: 91,
  },
  {
    question: 'How do I add or remove someone from the developer contact list?',
    answer: '<p><a href="/admin/support#developers"><strong>Support and Testing &rarr; Developers</strong></a> — add their name, email, and (optionally) role and phone. Anyone active in this list appears in the <strong>Assign to</strong> picker when a report is created, and a <strong>Remind</strong> on a report resends the notification to whoever it is assigned to.</p><p>Removing someone here only stops them being offered on future reports — a report already assigned to them keeps their name attached, since that name was captured on the report at the time.</p>',
    roleNote: 'super_admin',
    order: 92,
  },
  {
    question: 'What is the Testing tab, and how do I add a tester?',
    answer: '<p><a href="/admin/support#testing"><strong>Support and Testing &rarr; Testing</strong></a> controls who can sign in to the migration-testing portal at <a href="/command/testing">/command/testing</a>. Add an email there and that person can sign in with just that address — a one-time code is emailed to confirm it, no password to set or remember.</p><p>Once signed in, a tester meets the real site exactly as a brand-new, signed-out visitor would — they are not logged into any customer account — so they can run through the actual signup and login flow themselves. This is also what lets a tester through the site while <a href="/admin/settings#maintenance"><strong>maintenance mode</strong></a> is on, so the real site can be exercised while the public sees the maintenance page. Removing someone from this list immediately stops them signing in again, but does not end a session they are already in.</p>',
    roleNote: 'super_admin',
    order: 93,
  },

  // ── Configuration & operations ────────────────────────────────────────────
  {
    question: 'How do I put the site into maintenance mode, and write the message shown to visitors?',
    answer: '<p>Go to <a href="/admin/settings#maintenance"><strong>Site Settings &rarr; Maintenance</strong></a> and switch <strong>Maintenance mode</strong> on. Shoppers see a maintenance page with the message you write in the box underneath; the admin panel stays reachable so you can keep working.</p><p>The message box has its own toolbar for inserting a date, a time, or a live countdown — click the button, or just type <strong>{}</strong> anywhere in the text to get the same picker at your cursor. A countdown you insert ticks down live for every visitor and formats itself in their own clock, so you never have to write the date out by hand or keep it up to date.</p><p>Remember to switch maintenance mode off again. Nothing turns it off on a schedule.</p>',
    order: 100,
  },
  {
    question: 'How does the "upcoming maintenance" banner work, and how is it different from maintenance mode?',
    answer: '<p>Also on <a href="/admin/settings#maintenance"><strong>Site Settings &rarr; Maintenance</strong></a>, under <strong>Scheduled maintenance banner</strong> — a separate, smaller warning strip shown across the live site <em>before</em> maintenance actually starts, so visitors get advance notice. It uses the exact same message editor (toolbar, or typing <strong>{}</strong>) as the maintenance page itself.</p><p>If you write a countdown into this banner\'s message, the banner disappears on its own once that moment passes — there is nothing to remember to turn off. A message with no countdown in it just shows for as long as the toggle above it stays on.</p>',
    order: 101,
  },
  {
    question: 'Can a signed-in tester get past maintenance mode? How do I stop that?',
    answer: '<p>Yes, by default — the whole point of the <a href="/admin/support#testing"><strong>testing portal</strong></a> is exercising the real site while the public sees the maintenance page. The <strong>Testing portal access</strong> toggle on <a href="/admin/settings#maintenance"><strong>Site Settings &rarr; Maintenance</strong></a> controls this, and it is on by default.</p><p>Switch it off to lock testers out too — useful for checking the maintenance page itself holds up, or for a full lockdown during an actual cutover. Either way, the <a href="/command/testing">testing sign-in page</a> and the admin dashboard both stay reachable regardless of this toggle.</p>',
    order: 102,
  },
  {
    question: 'A provider is down. How do I stop sales failing?',
    answer: '<p>Under <a href="/admin/settings#provider"><strong>Site Settings &rarr; Provider</strong></a> you can switch the active data provider or turn individual features off. Doing that stops customers paying for something that cannot be delivered, which is better than refunding a run of failures afterwards.</p><p>Check the provider\'s own balance under <a href="/admin/ourdatastore"><strong>Service Providers &rarr; OurDataStore</strong></a> (or the GSubz equivalent) first — an empty provider wallet looks exactly like an outage from the customer\'s side.</p>',
    order: 103,
  },
  {
    question: 'How do I send a push notification, and can I choose exactly who gets it?',
    answer: '<p>Go to <a href="/admin/push-notifications"><strong>Configuration &rarr; Notifications</strong></a>, write the title and message, and send. Start typing in the recipient box and a matching list of users appears immediately — tick as many as you need, and the send goes only to the people you have ticked. Leaving it empty on the broadcast form sends to everyone, and you are asked to confirm before that goes out.</p><p>There is no recall once it is sent, so read it back before sending.</p>',
    order: 104,
  },
  {
    question: 'Where do I look when something has gone wrong?',
    answer: '<p><a href="/admin/logs"><strong>Configuration &rarr; System Logs</strong></a> holds recent errors and system events with timestamps. Start there, find the entry closest to when the problem happened, and include what it says in your bug report — it is usually the difference between a fix and a guess.</p>',
    order: 105,
  },

  // ── Own account ───────────────────────────────────────────────────────────
  {
    question: 'How do I change my own password?',
    answer: '<p>Go to <a href="/admin/profile#security"><strong>My Profile &rarr; Security</strong></a>. Enter your current password, then the new one twice.</p>',
    order: 110,
  },
  {
    question: 'How does admin two-factor sign-in work?',
    answer: '<p>Two-factor is on by default for every admin. After your username and password you are emailed a six-digit code, which is submitted automatically once you have entered all six digits. It expires after ten minutes, and <strong>Resend</strong> issues a new one.</p><p>You can turn it off for your own account under <a href="/admin/profile#security"><strong>My Profile &rarr; Security</strong></a>. If you cannot receive codes at all, a super admin can lift it for you from <a href="/admin/admins"><strong>Users &rarr; Admins</strong></a>.</p>',
    order: 111,
  },
];

module.exports = ADMIN_FAQ_SEED.map((e) => ({
  ...e,
  category: 'admin-dashboard',
  audience: 'admin',
  roleNote: e.roleNote || '',
}));

/* ── Route map, for whoever edits this next ──────────────────────────────────
   Users:            /admin/product/view-users        Admins: /admin/admins
   Products:         /admin/product/create-products (add) · /admin/product/view-products (list)
                      /admin/category/view-category (categories) · /admin/networks (data config)
   Transactions:      /admin/transactions · /admin/product/view-topUps (top-ups)
                      /admin/flagged-transactions · /admin/profit
                      /admin/payments-wallets  #markets #add #issues
   Growth & Rewards:  /admin/referrals  #overview #reward #signup #comm #paid #requests #reserved
   Announcements:     /admin/announcements  #banners #strips #popups #editor
   FAQ Manager:       /admin/faq  #admin-manual #list #editor
   Support & Testing: /admin/support  #developers #testing #create #reports
   Site Settings:     /admin/settings  #features #provider #maintenance
   Notifications:     /admin/push-notifications
   System Logs:        /admin/logs
   Service Providers: /admin/ourdatastore · /admin/gsubz · /admin/provider-analytics
   My Profile:        /admin/profile  #profile #security
   Testing portal (public, not under /admin): /command/testing
------------------------------------------------------------------------------- */
