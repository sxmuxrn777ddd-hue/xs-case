const { neon } = require('@neondatabase/serverless');

let connection;
let schemaPromise;

function getConnection() {
    const connectionString = (process.env.DATABASE_URL || '').trim();
    if (!connectionString) {
        throw new Error('Neon ma’lumotlar bazasi sozlanmagan (DATABASE_URL).');
    }
    if (!connection) connection = neon(connectionString);
    return connection;
}

async function ensureSchema() {
    if (!schemaPromise) {
        schemaPromise = (async () => {
            const sql = getConnection();
            await sql`
                CREATE TABLE IF NOT EXISTS xs_stars_wallets (
                    user_id TEXT PRIMARY KEY,
                    balance BIGINT NOT NULL CHECK (balance BETWEEN 0 AND 9007199254740991),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `;
            await sql`
                CREATE TABLE IF NOT EXISTS xs_stars_pending (
                    invoice_payload TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    username TEXT NOT NULL DEFAULT '',
                    display_name TEXT NOT NULL DEFAULT '',
                    public_id TEXT NOT NULL DEFAULT '',
                    referrer_id TEXT NOT NULL DEFAULT '',
                    amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 10000),
                    currency TEXT NOT NULL CHECK (currency = 'XTR'),
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    expires_at TIMESTAMPTZ NOT NULL
                )
            `;
            await sql`
                CREATE TABLE IF NOT EXISTS xs_stars_payments (
                    telegram_charge_id TEXT PRIMARY KEY,
                    invoice_payload TEXT NOT NULL UNIQUE,
                    user_id TEXT NOT NULL,
                    username TEXT NOT NULL DEFAULT '',
                    display_name TEXT NOT NULL DEFAULT '',
                    public_id TEXT NOT NULL DEFAULT '',
                    paid_amount INTEGER NOT NULL CHECK (paid_amount > 0),
                    currency TEXT NOT NULL CHECK (currency = 'XTR'),
                    purchased_stars INTEGER NOT NULL CHECK (purchased_stars > 0),
                    credited_stars INTEGER NOT NULL CHECK (credited_stars > 0),
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `;
            await sql`
                CREATE TABLE IF NOT EXISTS xs_stars_claims (
                    claim_key TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    amount INTEGER NOT NULL CHECK (amount > 0),
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `;
            await sql`
                CREATE TABLE IF NOT EXISTS xs_stars_slot_actions (
                    user_id TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    bet INTEGER NOT NULL CHECK (bet > 0),
                    multiplier INTEGER NOT NULL CHECK (multiplier >= 0),
                    reward INTEGER NOT NULL CHECK (reward >= 0),
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (user_id, request_id)
                )
            `;
        })().catch(error => {
            schemaPromise = null;
            throw error;
        });
    }
    return schemaPromise;
}

async function getWalletBalance(userId, initialBalance) {
    await ensureSchema();
    const sql = getConnection();
    await sql`
        INSERT INTO xs_stars_wallets (user_id, balance)
        VALUES (${userId}, ${initialBalance})
        ON CONFLICT (user_id) DO NOTHING
    `;
    const rows = await sql`
        SELECT balance FROM xs_stars_wallets WHERE user_id = ${userId}
    `;
    if (!rows.length) throw new Error('Foydalanuvchi hamyoni topilmadi.');
    return Number(rows[0].balance);
}

async function changeWalletBalance(userId, delta) {
    await ensureSchema();
    const sql = getConnection();
    const rows = await sql`
        UPDATE xs_stars_wallets
        SET balance = balance + ${delta}, updated_at = NOW()
        WHERE user_id = ${userId} AND balance + ${delta} >= 0
        RETURNING balance
    `;
    return rows.length ? Number(rows[0].balance) : null;
}

async function claimWalletReward(userId, amount, claimKey) {
    await ensureSchema();
    const sql = getConnection();
    const rows = await sql`
        WITH claimed AS (
            INSERT INTO xs_stars_claims (claim_key, user_id, amount)
            VALUES (${claimKey}, ${userId}, ${amount})
            ON CONFLICT (claim_key) DO NOTHING
            RETURNING user_id, amount
        ),
        wallet AS (
            INSERT INTO xs_stars_wallets (user_id, balance)
            SELECT user_id, amount FROM claimed
            ON CONFLICT (user_id) DO UPDATE
                SET balance = xs_stars_wallets.balance + EXCLUDED.balance,
                    updated_at = NOW()
            RETURNING balance
        )
        SELECT EXISTS (SELECT 1 FROM claimed) AS applied,
            (SELECT balance FROM wallet) AS balance
    `;
    return {
        applied: rows[0].applied,
        balance: rows[0].balance === null ? null : Number(rows[0].balance)
    };
}

async function settleSlotsAction(action) {
    await ensureSchema();
    const sql = getConnection();
    const rows = await sql`
        WITH existing AS (
            SELECT user_id, request_id, bet, multiplier, reward
            FROM xs_stars_slot_actions
            WHERE user_id = ${action.userId} AND request_id = ${action.requestId}
        ),
        eligible AS (
            SELECT user_id
            FROM xs_stars_wallets
            WHERE user_id = ${action.userId} AND balance >= ${action.bet}
            FOR UPDATE
        ),
        inserted AS (
            INSERT INTO xs_stars_slot_actions (user_id, request_id, bet, multiplier, reward)
            SELECT user_id, ${action.requestId}, ${action.bet}, ${action.multiplier}, ${action.reward}
            FROM eligible
            ON CONFLICT (user_id, request_id) DO NOTHING
            RETURNING user_id, request_id, bet, multiplier, reward
        ),
        wallet AS (
            UPDATE xs_stars_wallets AS wallet_row
            SET balance = wallet_row.balance + inserted.reward - inserted.bet,
                updated_at = NOW()
            FROM inserted
            WHERE wallet_row.user_id = inserted.user_id
            RETURNING wallet_row.user_id, wallet_row.balance
        )
        SELECT inserted.bet, inserted.multiplier, inserted.reward,
            wallet.balance, FALSE AS replayed
        FROM inserted
        JOIN wallet ON wallet.user_id = inserted.user_id
        UNION ALL
        SELECT existing.bet, existing.multiplier, existing.reward,
            current_wallet.balance, TRUE AS replayed
        FROM existing
        JOIN xs_stars_wallets AS current_wallet
            ON current_wallet.user_id = existing.user_id
        WHERE NOT EXISTS (SELECT 1 FROM inserted)
    `;
    if (rows.length) {
        return {
            bet: Number(rows[0].bet),
            multiplier: Number(rows[0].multiplier),
            reward: Number(rows[0].reward),
            balance: Number(rows[0].balance),
            replayed: rows[0].replayed
        };
    }

    const existing = await sql`
        SELECT action.bet, action.multiplier, action.reward, wallet.balance
        FROM xs_stars_slot_actions AS action
        JOIN xs_stars_wallets AS wallet ON wallet.user_id = action.user_id
        WHERE action.user_id = ${action.userId} AND action.request_id = ${action.requestId}
    `;
    if (!existing.length) return null;
    return {
        bet: Number(existing[0].bet),
        multiplier: Number(existing[0].multiplier),
        reward: Number(existing[0].reward),
        balance: Number(existing[0].balance),
        replayed: true
    };
}

async function createPendingPayment(payment) {
    await ensureSchema();
    const sql = getConnection();
    await sql`
        INSERT INTO xs_stars_pending (
            invoice_payload, user_id, username, display_name, public_id,
            referrer_id, amount, currency, expires_at
        )
        VALUES (
            ${payment.payload}, ${payment.userId}, ${payment.username},
            ${payment.displayName}, ${payment.publicId}, ${payment.referrerId},
            ${payment.amount}, 'XTR', NOW() + INTERVAL '2 hours'
        )
        ON CONFLICT (invoice_payload) DO NOTHING
    `;
}

async function deletePendingPayment(payload) {
    await ensureSchema();
    const sql = getConnection();
    await sql`DELETE FROM xs_stars_pending WHERE invoice_payload = ${payload}`;
}

async function getPendingPayment(payload) {
    await ensureSchema();
    const sql = getConnection();
    const rows = await sql`
        SELECT invoice_payload AS payload, user_id AS "userId",
            username, display_name AS "displayName", public_id AS "publicId",
            referrer_id AS "referrerId", amount, currency,
            created_at AS "createdAt", expires_at AS "expiresAt"
        FROM xs_stars_pending
        WHERE invoice_payload = ${payload}
    `;
    return rows[0] || null;
}

async function hasProcessedCharge(chargeId) {
    await ensureSchema();
    const sql = getConnection();
    const rows = await sql`
        SELECT 1 FROM xs_stars_payments WHERE telegram_charge_id = ${chargeId}
    `;
    return rows.length > 0;
}

async function creditPayment(payment) {
    await ensureSchema();
    const sql = getConnection();
    const rows = await sql`
        WITH valid_pending AS (
            SELECT * FROM xs_stars_pending
            WHERE invoice_payload = ${payment.payload}
                AND user_id = ${payment.userId}
                AND amount = ${payment.amount}
                AND currency = ${payment.currency}
        ),
        inserted AS (
            INSERT INTO xs_stars_payments (
                telegram_charge_id, invoice_payload, user_id, username,
                display_name, public_id, paid_amount, currency,
                purchased_stars, credited_stars
            )
            SELECT ${payment.chargeId}, invoice_payload, user_id, username,
                display_name, public_id, ${payment.paidAmount}, currency,
                amount, amount
            FROM valid_pending
            ON CONFLICT DO NOTHING
            RETURNING *
        ),
        wallet AS (
            INSERT INTO xs_stars_wallets (user_id, balance)
            SELECT user_id, credited_stars FROM inserted
            ON CONFLICT (user_id) DO UPDATE
                SET balance = xs_stars_wallets.balance + EXCLUDED.balance,
                    updated_at = NOW()
            RETURNING user_id, balance
        ),
        referral_credit AS (
            SELECT pending.referrer_id AS user_id,
                FLOOR(inserted.credited_stars * ${payment.referralRewardPercent} / 100)::INTEGER AS amount
            FROM inserted
            JOIN valid_pending AS pending
                ON pending.invoice_payload = inserted.invoice_payload
            WHERE pending.referrer_id <> inserted.user_id
                AND pending.referrer_id <> ''
                AND FLOOR(inserted.credited_stars * ${payment.referralRewardPercent} / 100) >= 1
        ),
        referral_wallet AS (
            INSERT INTO xs_stars_wallets (user_id, balance)
            SELECT user_id, amount FROM referral_credit
            ON CONFLICT (user_id) DO UPDATE
                SET balance = xs_stars_wallets.balance + EXCLUDED.balance,
                    updated_at = NOW()
            RETURNING user_id, balance
        ),
        deleted_pending AS (
            DELETE FROM xs_stars_pending
            WHERE invoice_payload = ${payment.payload}
                AND EXISTS (SELECT 1 FROM inserted)
            RETURNING invoice_payload
        )
        SELECT inserted.telegram_charge_id AS "chargeId",
            inserted.user_id AS "userId",
            inserted.username,
            inserted.display_name AS "displayName",
            inserted.public_id AS "publicId",
            inserted.paid_amount AS "paidAmount",
            inserted.purchased_stars AS "purchasedStars",
            inserted.credited_stars AS "creditedStars",
            inserted.created_at AS "createdAt",
            wallet.balance AS "balanceAfter",
            referral_wallet.user_id AS "referralUserId",
            referral_wallet.balance AS "referralBalance",
            referral_credit.amount AS "referralReward"
        FROM inserted
        JOIN wallet ON wallet.user_id = inserted.user_id
        LEFT JOIN referral_credit ON TRUE
        LEFT JOIN referral_wallet ON referral_wallet.user_id = referral_credit.user_id
    `;
    return rows[0] || null;
}

async function listPayments(limit = 100, offset = 0) {
    await ensureSchema();
    const sql = getConnection();
    const [totals, payments] = await Promise.all([
        sql`
            SELECT COALESCE(SUM(credited_stars), 0)::BIGINT AS total,
                COUNT(*)::BIGINT AS count
            FROM xs_stars_payments
        `,
        sql`
            SELECT telegram_charge_id AS "chargeId", user_id AS "userId",
                username, display_name AS "displayName", public_id AS "publicId",
                paid_amount AS "paidAmount", currency,
                purchased_stars AS "purchasedStars",
                credited_stars AS "creditedStars",
                created_at AS "createdAt"
            FROM xs_stars_payments
            ORDER BY created_at DESC
            LIMIT ${limit}
            OFFSET ${offset}
        `
    ]);
    return {
        paidStarsTotal: Number(totals[0].total),
        paymentCount: Number(totals[0].count),
        payments: payments.map(payment => ({
            ...payment,
            paidAmount: Number(payment.paidAmount),
            purchasedStars: Number(payment.purchasedStars),
            creditedStars: Number(payment.creditedStars)
        }))
    };
}

module.exports = {
    ensureSchema,
    getWalletBalance,
    changeWalletBalance,
    claimWalletReward,
    settleSlotsAction,
    createPendingPayment,
    deletePendingPayment,
    getPendingPayment,
    hasProcessedCharge,
    creditPayment,
    listPayments
};
