/**
 * The admin dashboard manual, seeded as FAQ entries.
 *
 * One entry per thing an admin can actually do, written as steps rather than
 * description — the test of an entry is whether someone who has never opened
 * the panel could follow it and finish the task.
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
    answer: '<p>Pages with several groups of settings show a secondary drawer on the left of the content area. Each entry opens a section of that page without a reload, and your choice is remembered — reloading or sharing the link brings you back to the same section.</p><p>The page title is the name of the panel; the line under it tells you which section you are currently in.</p>',
    order: 2,
  },

  // ── Users ─────────────────────────────────────────────────────────────────
  {
    question: 'How do I look up a user and see their full history?',
    answer: '<p>Go to <strong>Users &rarr; View Users</strong> and search by username, email, or phone number. Click the user to open their details page, which shows their wallet balances, transactions, top-ups, reward points, and referral activity in one place.</p>',
    order: 10,
  },
  {
    question: 'How do I credit or debit a user\'s wallet manually?',
    answer: '<p>Open the user from <strong>Users &rarr; View Users</strong>, then use the wallet controls on their details page. Enter the amount and a reason — the reason is written into the audit trail, so state what the adjustment is for.</p><p>Every manual adjustment records the balance before and after, who made it, and when. It cannot be edited afterwards; a mistake is corrected with a second, opposite adjustment so both movements stay visible.</p>',
    order: 11,
  },
  {
    question: 'How do I see who referred a user, and who they referred?',
    answer: '<p>Open the user from <strong>Users &rarr; View Users</strong> and scroll to the <strong>Referrals</strong> section. It shows their own referral code, who referred them, everyone they have referred, and the reward and commission paid on each — including any past codes they used to own, which stay valid permanently.</p>',
    order: 12,
  },

  // ── Admin accounts ────────────────────────────────────────────────────────
  {
    question: 'How do I add a new admin?',
    answer: '<p>Go to <strong>Users &rarr; Admins</strong> and use <strong>Add Admin</strong>. Enter their username, email, and role. They receive their sign-in details by email and are asked to complete their profile on first login.</p><p>Choose the lowest role that lets them do their job — roles can be raised later without recreating the account.</p>',
    roleNote: 'super_admin',
    order: 20,
  },
  {
    question: 'What can each admin role do?',
    answer: '<p>There are three roles:</p><ul><li><strong>Junior admin</strong> — day-to-day work: viewing users, processing top-ups, handling transactions.</li><li><strong>Senior admin</strong> — the same, plus product, pricing, and configuration changes.</li><li><strong>Super admin</strong> — everything, plus the actions no one else can take: managing admin accounts and roles, approving refunds and password resets, editing this manual, and setting the developer contact.</li></ul><p>Any action restricted to a single role is marked with a note on its entry in this manual.</p>',
    order: 21,
  },
  {
    question: 'How do I change an admin\'s role, deactivate them, or remove them?',
    answer: '<p>Go to <strong>Users &rarr; Admins</strong> and use the controls on that admin\'s row. Deactivating keeps the account and its history but blocks sign-in, and takes effect within five minutes even if they are already signed in. Deleting removes the account entirely.</p><p>Prefer deactivating over deleting — it is reversible, and it keeps their name attached to the actions they took.</p>',
    roleNote: 'super_admin',
    order: 22,
  },
  {
    question: 'An admin cannot receive their two-factor code. How do I get them back in?',
    answer: '<p>Go to <strong>Users &rarr; Admins</strong> and turn off two-factor for that admin. This is the deliberate escape hatch for a broken inbox. The panel records who granted the exemption and when, because removing a second factor is a security decision.</p><p>Turn it back on once their email is working. Note that two-factor cannot be removed from another super admin.</p>',
    roleNote: 'super_admin',
    order: 23,
  },
  {
    question: 'How do I approve a user\'s password reset request?',
    answer: '<p>Pending reset requests appear under <strong>Users</strong>. Open the request, confirm the user is who they say they are through a channel other than the email on the account, then approve it. The user is emailed a link to set a new password.</p>',
    roleNote: 'super_admin',
    order: 24,
  },

  // ── Products ──────────────────────────────────────────────────────────────
  {
    question: 'How do I add a new product?',
    answer: '<p>Go to <strong>Products &rarr; Create Products</strong>. Pick the category, then fill in the fields that category asks for. Data bundles additionally need a network and a provider plan ID so the bundle can actually be delivered.</p><p>Set the <strong>country</strong> before saving — it decides which shoppers can see and buy the product. A product left on the default is a Nigerian product.</p>',
    order: 30,
  },
  {
    question: 'How do I change a price, or take a product off sale?',
    answer: '<p>Go to <strong>Products &rarr; View Products</strong>, find the product, and click edit. Change the price and save; it applies to new purchases immediately.</p><p>To take something off sale without losing its history, switch it inactive rather than deleting it. Deleting hides it from past transactions too, which makes older orders harder to read.</p>',
    order: 31,
  },
  {
    question: 'What is the bonus field on a data product?',
    answer: '<p>The bonus is the extra value credited on top of the bundle a customer buys. Leave it empty or zero for no bonus.</p><p>It is saved per product, so changing it on one bundle does not affect the others.</p>',
    order: 32,
  },
  {
    question: 'How do I manage networks and their plans?',
    answer: '<p>Go to <strong>Products &rarr; Networks</strong>. Each network holds the plan IDs used when a bundle is sent to the provider. If a bundle is failing to deliver, check the plan ID here against the provider\'s own list first — a wrong ID is the most common cause.</p>',
    order: 33,
  },
  {
    question: 'How do I add or reorder categories?',
    answer: '<p>Go to <strong>Products &rarr; Categories</strong>. Add, rename, or reorder from there; the order set here is the order shoppers see.</p>',
    order: 34,
  },

  // ── Transactions ──────────────────────────────────────────────────────────
  {
    question: 'How do I confirm a manual top-up?',
    answer: '<p>Go to <strong>Transactions &rarr; Top-Ups</strong>. Pending manual top-ups are listed with the amount and reference the user submitted. Verify the money actually arrived in the receiving account, then approve — approving credits the user\'s wallet immediately.</p><p>Always check the payment before approving. An approval is a real credit, and reversing it means a manual debit that the customer will see.</p>',
    order: 40,
  },
  {
    question: 'How do I find a specific transaction?',
    answer: '<p>Go to <strong>Transactions</strong> and filter by status, date range, or search the reference, username, or phone number. Each row opens to show the full record, including the wallet balance before and after and the provider\'s response.</p>',
    order: 41,
  },
  {
    question: 'What are flagged transactions, and what do the tabs mean?',
    answer: '<p><strong>Transactions &rarr; Flagged Transactions</strong> lists orders where what the customer received did not match what they paid for — usually a short delivery from the provider.</p><ul><li><strong>Deducted</strong> — the shortfall has been taken off the provider\'s account.</li><li><strong>Cleared</strong> — reviewed and found correct, no action needed.</li><li><strong>Refunded</strong> — the undelivered portion was credited back to the customer\'s wallet.</li></ul>',
    order: 42,
  },
  {
    question: 'How do I refund a customer for a short delivery?',
    answer: '<p>Open the flagged transaction under <strong>Transactions &rarr; Flagged Transactions</strong> and raise a refund request, stating what was short. A super admin then approves it, and the undelivered portion is credited to the customer\'s wallet.</p><p>Any admin can raise the request; only a super admin can approve it, so refunds always involve two people.</p>',
    order: 43,
  },
  {
    question: 'How do I approve a pending refund request?',
    answer: '<p>Open <strong>Transactions &rarr; Flagged Transactions</strong>, review the pending request against the provider\'s response on the original order, then approve or decline it. Approving credits the customer\'s wallet straight away.</p>',
    roleNote: 'super_admin',
    order: 44,
  },
  {
    question: 'Where do I see how much the business is actually making?',
    answer: '<p>Go to <strong>Transactions &rarr; Profit</strong>. It shows revenue against provider cost over the period you choose, so you can see margin per product rather than just sales volume.</p>',
    order: 45,
  },

  // ── Payments & wallets ────────────────────────────────────────────────────
  {
    question: 'How do I open the store in a new country?',
    answer: '<p>Go to <strong>Transactions &rarr; Payments &amp; Wallets</strong> and add a wallet for that country. Creating the wallet is what makes the country live: users get a balance in its currency and can be shown its products.</p><p>Then add at least one payment method for it, otherwise shoppers there can browse but cannot pay. The panel warns you about any country in exactly that state.</p>',
    order: 50,
  },
  {
    question: 'How do I add a payment method for a country?',
    answer: '<p>Open <strong>Transactions &rarr; Payments &amp; Wallets</strong>, select the country\'s wallet, and add the method with the account details a customer should pay into. A new country starts with manual funding — the customer pays out of band and an admin confirms it under Top-Ups.</p>',
    order: 51,
  },
  {
    question: 'Why can I not delete a country wallet?',
    answer: '<p>A wallet cannot be removed while any user still holds money in that currency, because deleting it would strand their balance. The panel tells you how many holders there are.</p><p>If there are none and it still refuses, the wallet is Nigeria — the fallback market, which cannot be removed. Hide it from shoppers instead of deleting it.</p>',
    order: 52,
  },

  // ── Growth & rewards ──────────────────────────────────────────────────────
  {
    question: 'How do I turn the signup bonus on or off?',
    answer: '<p>Go to <strong>Configuration &rarr; Growth &amp; Rewards</strong> and open the signup bonus section. Choose whether it pays reward points or money, set the amount, and switch it active.</p><p>It is paid when a new user verifies their email, not at signup — signing up is free and unlimited, so paying before verification would let one person farm it with throwaway addresses.</p>',
    order: 60,
  },
  {
    question: 'How do I set the referral reward and the ongoing commission?',
    answer: '<p>Both are under <strong>Configuration &rarr; Growth &amp; Rewards</strong>. The <strong>reward</strong> is the one-off payment when a referred user qualifies. The <strong>commission</strong> is a percentage of every purchase they make afterwards.</p><p>Each has its own bonus setting, and the commission can be set to zero — that switches off ongoing earnings while keeping the one-off reward.</p>',
    order: 61,
  },
  {
    question: 'How do special and custom referral codes work?',
    answer: '<p>Under <strong>Configuration &rarr; Growth &amp; Rewards</strong> you can put paid codes on sale and set a separate price and bonus for each kind:</p><ul><li><strong>Special</strong> — a code the user picks from a pool you have reserved. Enter them in bulk, comma separated, using letters and numbers only.</li><li><strong>Custom</strong> — a code the user chooses themselves, checked for length and availability.</li></ul><p>Requests need approving before payment goes through, which is what stops an offensive custom code going live. Turn on auto-approve only if you are willing to give up that check.</p>',
    order: 62,
  },
  {
    question: 'If a user changes their referral code, do their old links stop working?',
    answer: '<p>No. Codes are kept in their own record with the user attached, so every code a user has ever held keeps resolving to them permanently. Old links and posts carry on working.</p><p>Their past codes are listed on their details page under <strong>Users &rarr; View Users</strong>, and on their own dashboard.</p>',
    order: 63,
  },

  // ── Announcements ─────────────────────────────────────────────────────────
  {
    question: 'How do I put a banner, strip, or popup on the site?',
    answer: '<p>Go to <strong>Configuration &rarr; Announcements</strong> and pick the surface:</p><ul><li><strong>Banner</strong> — a slide in the home page hero.</li><li><strong>Strip</strong> — a thin bar under the header.</li><li><strong>Popup</strong> — a card shown to a signed-in user.</li></ul><p>Changes appear on the site within a minute.</p>',
    order: 70,
  },
  {
    question: 'How do I make an announcement expire on its own?',
    answer: '<p>Set a countdown end date on it. Once that moment passes the announcement stops rendering by itself, so a finished promotion does not need remembering to take down.</p><p>On a strip you can also put <strong>{countdown}</strong> in the text, and it is replaced with a live ticking timer.</p>',
    order: 71,
  },
  {
    question: 'How do the new-feature popups work?',
    answer: '<p>Several active popups become a stepped tour: a signed-in user sees the first, moves through with <strong>Next</strong>, and the set is marked seen when they finish or close it. Reorder them under <strong>Configuration &rarr; Announcements</strong> — the order field is the order they are shown in.</p><p>Deactivate one to drop it from the tour without deleting it.</p>',
    order: 72,
  },

  // ── This manual ───────────────────────────────────────────────────────────
  {
    question: 'How do I edit this admin manual?',
    answer: '<p>Go to <strong>Configuration &rarr; FAQ Manager</strong> and choose the <strong>Admin Dashboard</strong> section. Entries here are only ever shown inside the panel — they never appear on the public FAQ page.</p><p>If an entry describes something only one role can do, set its role note so the restriction is visible on the entry itself.</p>',
    roleNote: 'super_admin',
    order: 80,
  },
  {
    question: 'How do I edit the FAQ that customers see?',
    answer: '<p><strong>Configuration &rarr; FAQ Manager</strong>, in any section other than Admin Dashboard. Pick the category it belongs under, write the answer in the editor, and save. It appears on the public FAQ page immediately.</p><p>Switch an entry inactive to pull it from the site while you rework it, rather than deleting it.</p>',
    order: 81,
  },

  // ── Support & reports ─────────────────────────────────────────────────────
  {
    question: 'I have found a bug. How do I report it?',
    answer: '<p>Go to <strong>Support &amp; Reports &rarr; Create a Report</strong>. Give it a title, say whether it is on the client site or the admin dashboard, name the page, and describe what happened.</p><p>Say what you did, what you expected, and what actually happened — a report that says only "it is broken" usually needs a second conversation before anyone can act on it. Submitting also emails the developer on file.</p>',
    order: 90,
  },
  {
    question: 'Where do I see the reports I have submitted?',
    answer: '<p><strong>Support &amp; Reports &rarr; Reports</strong> lists your own reports with the time you submitted each and its current status. A super admin sees every report along with who filed it.</p>',
    order: 91,
  },
  {
    question: 'Who do I contact about something urgent?',
    answer: '<p>The current developer contact is on <strong>Support &amp; Reports &rarr; Dev Info</strong>. Use a report for anything that can wait, and the contact there for something actively breaking.</p>',
    order: 92,
  },
  {
    question: 'How do I change the developer contact?',
    answer: '<p><strong>Support &amp; Reports &rarr; Dev Info</strong>, then edit the name and email. The email set here is where every new report is sent, so check it carefully — a typo means reports are submitted successfully and silently go nowhere.</p>',
    roleNote: 'super_admin',
    order: 93,
  },

  // ── Configuration & operations ────────────────────────────────────────────
  {
    question: 'How do I put the site into maintenance mode?',
    answer: '<p>Go to <strong>Configuration &rarr; Settings</strong> and switch maintenance mode on. Shoppers see a maintenance page; the admin panel stays reachable so you can keep working.</p><p>Remember to switch it off. Nothing turns it off on a schedule.</p>',
    order: 100,
  },
  {
    question: 'A provider is down. How do I stop sales failing?',
    answer: '<p>Under <strong>Configuration &rarr; Settings</strong> you can switch the active data provider or turn individual features off. Doing that stops customers paying for something that cannot be delivered, which is better than refunding a run of failures afterwards.</p><p>Check the provider\'s own balance under <strong>Configuration &rarr; OurDataStore</strong> first — an empty provider wallet looks exactly like an outage from the customer\'s side.</p>',
    order: 101,
  },
  {
    question: 'How do I send a push notification?',
    answer: '<p>Go to <strong>Configuration &rarr; Push Notifications</strong>, write the title and message, and send. It reaches users who have allowed notifications in their browser.</p><p>There is no recall once it is sent, so read it back before sending.</p>',
    order: 102,
  },
  {
    question: 'Where do I look when something has gone wrong?',
    answer: '<p><strong>Configuration &rarr; System Logs</strong> holds recent errors and system events with timestamps. Start there, find the entry closest to when the problem happened, and include what it says in your bug report — it is usually the difference between a fix and a guess.</p>',
    order: 103,
  },

  // ── Own account ───────────────────────────────────────────────────────────
  {
    question: 'How do I change my own password?',
    answer: '<p>Go to <strong>Account &rarr; My Profile</strong> and open the <strong>Security</strong> section. Enter your current password, then the new one twice.</p>',
    order: 110,
  },
  {
    question: 'How does admin two-factor sign-in work?',
    answer: '<p>Two-factor is on by default for every admin. After your username and password you are emailed a six-digit code, which is submitted automatically once you have entered all six digits. It expires after ten minutes, and <strong>Resend</strong> issues a new one.</p><p>You can turn it off for your own account under <strong>Account &rarr; My Profile &rarr; Security</strong>. If you cannot receive codes at all, a super admin can lift it for you.</p>',
    order: 111,
  },
];

module.exports = ADMIN_FAQ_SEED.map((e) => ({
  ...e,
  category: 'admin-dashboard',
  audience: 'admin',
  roleNote: e.roleNote || '',
}));
