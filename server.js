const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { Server } = require('socket.io');
const path = require('path');
const starsStore = require('./stars-store');
const { createInvoicePayload, hasValidInvoicePayload } = require('./stars-utils');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const isHostedRuntime = Boolean(
    process.env.RENDER_EXTERNAL_URL ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_PUBLIC_DOMAIN
);
const localDevMode = !process.env.BOT_TOKEN && process.env.NODE_ENV !== 'production' && !isHostedRuntime;
const localDevUser = Object.freeze({
    id: 900000001,
    username: 'localdev',
    first_name: 'Local',
    last_name: 'Player'
});
const dataFile = process.env.USER_DATA_FILE || path.join(
    __dirname,
    process.env.VERCEL
        ? path.join('/tmp', 'user-data.json')
        : (localDevMode ? 'user-data.local.json' : 'user-data.json')
);

app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(res) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
}));
app.use(express.json());

app.get(['/', '/index.html'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/config-status', (req, res) => {
    res.json({
        botToken: !getBotTokenError(),
        adminToken: Boolean(process.env.ADMIN_TOKEN),
        database: Boolean(process.env.DATABASE_URL),
        publicUrl: Boolean(
            process.env.PUBLIC_URL ||
            process.env.VERCEL_PROJECT_PRODUCTION_URL ||
            process.env.RENDER_EXTERNAL_URL ||
            process.env.RAILWAY_PUBLIC_DOMAIN
        ),
        webhookSecret: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET)
    });
});

const defaultPromocodes = {
    XS2026: 50,
    START: 25
};
const casePaidCost = 50;
const caseFreeCooldownMs = 24 * 60 * 60 * 1000;
const spinCost = casePaidCost;

const caseAllPrizes = [10, 20, 30, 50, 100, 120, 150, 200, 500, 1000, 10000];

const caseFreePrizes = [
    { reward: 10, weight: 9500, chancePercent: 95 },
    { reward: 20, weight: 499, chancePercent: 4.99 },
    { reward: 30, weight: 1, chancePercent: 0.01 }
];
const caseFreeTotalWeight = caseFreePrizes.reduce((sum, p) => sum + p.weight, 0);

const casePaidPrizes = [
    { reward: 10, weight: 6500, chancePercent: 65 },
    { reward: 20, weight: 2000, chancePercent: 20 },
    { reward: 30, weight: 500, chancePercent: 5 },
    { reward: 50, weight: 500, chancePercent: 5 },
    { reward: 100, weight: 389, chancePercent: 3.89 },
    { reward: 120, weight: 50, chancePercent: 0.5 },
    { reward: 150, weight: 30, chancePercent: 0.3 },
    { reward: 200, weight: 15, chancePercent: 0.15 },
    { reward: 500, weight: 10, chancePercent: 0.1 },
    { reward: 1000, weight: 5, chancePercent: 0.05 },
    { reward: 10000, weight: 1, chancePercent: 0.01 }
];
const casePaidTotalWeight = casePaidPrizes.reduce((sum, p) => sum + p.weight, 0);

function rollCasePrize(isFree) {
    const list = isFree ? caseFreePrizes : casePaidPrizes;
    const total = isFree ? caseFreeTotalWeight : casePaidTotalWeight;
    let roll = crypto.randomInt(total);
    for (const item of list) {
        if (roll < item.weight) return item;
        roll -= item.weight;
    }
    return list[0];
}
const slotsBetOptions = [69, 149, 399, 999];
const slotsOutcomes = [
    { multiplier: 0, weight: 7300 },
    { multiplier: 2, weight: 2000 },
    { multiplier: 5, weight: 500 },
    { multiplier: 10, weight: 150 },
    { multiplier: 20, weight: 50 }
];
const slotsOutcomeWeight = slotsOutcomes.reduce((total, outcome) => total + outcome.weight, 0);
const pvpLobbySeconds = 15;
const pvpSpinDurationMs = 6000;
const pvpWinnerSharePercent = 80;
const pvpMaxPlayers = 100;
const pvpMaxBet = 100000;
const tournamentPrizes = [100, 80, 50, 20, 20, 20, 20, 20, 20, 20];
const tournamentWeekMs = 7 * 24 * 60 * 60 * 1000;
const tashkentOffsetMs = 5 * 60 * 60 * 1000;
const channelUsername = '@xscase';
const referralRewardPercent = 15;

function loadDatabase() {
    try {
        return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { users: {} };
        }
        throw error;
    }
}

const database = loadDatabase();
if (!database.users) database.users = {};
if (!database.promocodes) database.promocodes = { ...defaultPromocodes };
if (!database.pendingPayments) database.pendingPayments = {};
if (!database.processedPayments) database.processedPayments = {};
if (!Array.isArray(database.ledger)) database.ledger = [];
if (!database.slotActions || typeof database.slotActions !== 'object' || Array.isArray(database.slotActions)) database.slotActions = {};
if (!database.tournamentPayouts || typeof database.tournamentPayouts !== 'object' || Array.isArray(database.tournamentPayouts)) database.tournamentPayouts = {};
if (!Number.isSafeInteger(database.adminCommissionBalance)) {
    database.adminCommissionBalance = database.ledger
        .filter(entry => entry.type === 'admin_commission')
        .reduce((total, entry) => total + (Number(entry.amount) || 0), 0);
}

function saveDatabase() {
    const temporaryFile = `${dataFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(database, null, 2));
    fs.renameSync(temporaryFile, dataFile);
}

const recordedPaymentReferences = new Set(
    database.ledger
        .filter(entry => entry.type === 'telegram_payment')
        .map(entry => entry.reference)
);
let migratedPayments = false;
for (const [chargeId, payment] of Object.entries(database.processedPayments)) {
    const amount = Number(payment && payment.amount);
    if (recordedPaymentReferences.has(chargeId) ||
        !payment || !Number.isSafeInteger(amount) || amount < 1 ||
        typeof payment.userId !== 'string') {
        continue;
    }

    const processedAt = Number(payment.processedAt);
    const profile = database.users[payment.userId];
    database.ledger.push({
        id: crypto.randomUUID(),
        userId: payment.userId,
        publicId: profile ? profile.publicId : '',
        displayName: profile
            ? (profile.username
                ? `@${profile.username}`
                : [profile.firstName, profile.lastName].filter(Boolean).join(' '))
            : '',
        type: 'telegram_payment',
        amount,
        balanceAfter: null,
        reference: chargeId,
        createdAt: new Date(Number.isFinite(processedAt) ? processedAt : Date.now()).toISOString()
    });
    recordedPaymentReferences.add(chargeId);
    migratedPayments = true;
}
if (migratedPayments) saveDatabase();

function recordLedgerEntry(profile, type, amount, balanceAfter, reference) {
    database.ledger.push({
        id: crypto.randomUUID(),
        userId: profile.id,
        publicId: profile.publicId,
        displayName: profile.username
            ? `@${profile.username}`
            : [profile.firstName, profile.lastName].filter(Boolean).join(' '),
        type,
        amount,
        balanceAfter,
        reference: reference || '',
        createdAt: new Date().toISOString()
    });
}

function recordAdminCommission(amount, reference) {
    database.adminCommissionBalance += amount;
    database.ledger.push({
        id: crypto.randomUUID(),
        userId: '',
        publicId: 'admin-fund',
        displayName: 'XS Case admin fondi',
        type: 'admin_commission',
        amount,
        balanceAfter: database.adminCommissionBalance,
        reference: reference || '',
        createdAt: new Date().toISOString()
    });
}

function getBotTokenError() {
    const botToken = (process.env.BOT_TOKEN || '').trim();
    if (!botToken) return 'Telegram bot token sozlanmagan (BOT_TOKEN).';
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
        return 'BOT_TOKEN formati noto‘g‘ri. BotFather bergan tokenni hosting Environment Variables bo‘limida tekshiring.';
    }
    return null;
}

function getConfiguredBotToken() {
    return (process.env.BOT_TOKEN || '').trim();
}

function verifyTelegramInitData(initData) {
    if (localDevMode) {
        return { user: localDevUser, startParam: '' };
    }

    const botToken = getConfiguredBotToken();
    const tokenError = getBotTokenError();
    if (tokenError) return { error: tokenError };

    if (!initData) {
        return { error: 'Hisob va to‘lovlar uchun botdagi Mini Appni Telegram ichidan oching.' };
    }

    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) {
        return { error: 'Telegram foydalanuvchisini tekshirib bo‘lmadi.' };
    }

    const dataCheckString = Array.from(params.entries())
        .filter(([key]) => key !== 'hash')
        .sort(([keyA], [keyB]) => keyA < keyB ? -1 : keyA > keyB ? 1 : 0)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest();
    const receivedHash = Buffer.from(hash, 'hex');

    if (!crypto.timingSafeEqual(expectedHash, receivedHash)) {
        return {
            error: 'Telegram imzosi tasdiqlanmadi. Mini Appni bot ichidan oching va serverdagi BOT_TOKEN aynan shu botnikiga mosligini tekshiring.'
        };
    }

    const authDate = Number(params.get('auth_date'));
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(authDate) || authDate > now + 60 || now - authDate > 86400) {
        return { error: 'Telegram sessiyasi eskirgan. Mini Appni qayta oching.' };
    }

    let user;
    try {
        user = JSON.parse(params.get('user') || '');
    } catch (error) {
        return { error: 'Telegram foydalanuvchisini tekshirib bo‘lmadi.' };
    }

    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) {
        return { error: 'Telegram foydalanuvchisini tekshirib bo‘lmadi.' };
    }

    return { user, startParam: params.get('start_param') || '' };
}

function authenticateRequest(req, res, next) {
    const result = verifyTelegramInitData(req.get('x-telegram-init-data'));
    if (result.error) {
        return res.status(result.error.includes('BOT_TOKEN') ? 503 : 401)
            .json({ error: result.error });
    }
    req.telegramUser = result.user;
    req.telegramStartParam = result.startParam;
    if (localDevMode) return next();

    Promise.resolve()
        .then(() => starsStore.ensureSchema())
        .then(() => {
            const profile = getUserProfile(req.telegramUser, req.telegramStartParam);
            return starsStore.getWalletBalance(profile.id, profile.balance)
                .then(balance => { profile.balance = balance; });
        })
        .then(() => next())
        .catch(error => {
            console.error('Foydalanuvchi hamyoni yuklanmadi:', error.message);
            res.status(503).json({ error: 'Stars balansi vaqtincha yuklanmadi. Keyinroq qayta urinib ko‘ring.' });
        });
}

function authenticateAdmin(req, res, next) {
    if (localDevMode) return next();

    const expectedToken = process.env.ADMIN_TOKEN;
    if (!expectedToken) {
        return res.status(503).json({ error: 'Admin token sozlanmagan (ADMIN_TOKEN).' });
    }
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(expectedToken)) {
        return res.status(503).json({
            error: 'ADMIN_TOKEN 32–256 ta harf, raqam, _ yoki - dan iborat bo‘lishi kerak.'
        });
    }

    const providedToken = Buffer.from(req.get('x-admin-token') || '');
    const configuredToken = Buffer.from(expectedToken);
    if (providedToken.length !== configuredToken.length ||
        !crypto.timingSafeEqual(providedToken,
            
            configuredToken)) {
        return res.status(401).json({ error: 'Admin token noto‘g‘ri.' });
    }

    next();
}

function getPublicPlayerName(profile) {
    if (profile.displayMode === 'custom' && profile.customDisplayName) {
        return profile.customDisplayName;
    }
    if (profile.displayMode === 'telegram') {
        if (profile.username) return `@${profile.username}`;
        const telegramName = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
        if (telegramName) return telegramName;
    }
    return profile.publicId.slice(-4);
}

function getPublicPlayer(profile) {
    return {
        displayName: getPublicPlayerName(profile),
        idSuffix: profile.publicId.slice(-4),
        initials: getPublicPlayerName(profile).slice(0, 2).toUpperCase(),
        photoUrl: profile.photoUrl || ''
    };
}

function getUserProfile(telegramUser, startParam) {
    const id = String(telegramUser.id);
    let profile = database.users[id];
    if (!profile) {
        const referralMatch = /^ref_(\d{1,20})$/.exec(startParam || '');
        const referrerId = referralMatch && referralMatch[1] !== id && database.users[referralMatch[1]]
            ? referralMatch[1]
            : '';
        profile = database.users[id] = {
            id,
            publicId: generatePublicId(),
            username: telegramUser.username || '',
            firstName: telegramUser.first_name || '',
            lastName: telegramUser.last_name || '',
            photoUrl: typeof telegramUser.photo_url === 'string' &&
                telegramUser.photo_url.startsWith('https://') &&
                telegramUser.photo_url.length <= 2048
                ? telegramUser.photo_url
                : '',
            balance: localDevMode ? 10000 : 0,
            bonusBalance: 0,
            lastFreeSpinAt: 0,
            usedPromos: [],
            referredBy: referrerId,
            displayMode: 'id',
            customDisplayName: '',
            channelTaskClaimed: false
        };
        saveDatabase();
    } else {
        let changed = false;
        const duplicatePublicId = Object.entries(database.users)
            .some(([otherId, otherProfile]) => otherId !== id && otherProfile.publicId === profile.publicId);
        if (!isValidPublicId(profile.publicId) || duplicatePublicId) {
            profile.publicId = generatePublicId(id);
            changed = true;
        }
        if (!Array.isArray(profile.usedPromos)) {
            profile.usedPromos = [];
            changed = true;
        }
        if (typeof profile.referredBy !== 'string') {
            profile.referredBy = '';
            changed = true;
        }
        if (!['id', 'telegram', 'custom'].includes(profile.displayMode)) {
            profile.displayMode = 'id';
            changed = true;
        }
        if (typeof profile.customDisplayName !== 'string') {
            profile.customDisplayName = '';
            changed = true;
        }
        if (typeof profile.channelTaskClaimed !== 'boolean') {
            profile.channelTaskClaimed = false;
            changed = true;
        }
        if (typeof profile.lastFreeSpinAt !== 'number') {
            profile.lastFreeSpinAt = 0;
            changed = true;
        }
        if (typeof profile.bonusBalance !== 'number') {
            profile.bonusBalance = 0;
            changed = true;
        }
        const username = telegramUser.username || '';
        const firstName = telegramUser.first_name || '';
        const lastName = telegramUser.last_name || '';
        const photoUrl = typeof telegramUser.photo_url === 'string' &&
            telegramUser.photo_url.startsWith('https://') &&
            telegramUser.photo_url.length <= 2048
            ? telegramUser.photo_url
            : '';
        if (profile.username !== username || profile.firstName !== firstName ||
            profile.lastName !== lastName || profile.photoUrl !== photoUrl) {
            profile.username = username;
            profile.firstName = firstName;
            profile.lastName = lastName;
            profile.photoUrl = photoUrl;
            changed = true;
        }

        if (changed) saveDatabase();
    }
    return profile;
}

function generatePublicId(exceptUserId) {
    let publicId;
    do {
        let digits = '7';
        while (digits.length < 11) {
            const nextDigit = String(crypto.randomInt(10));
            if (digits.length >= 4 && digits.slice(-4) === nextDigit.repeat(4)) continue;
            digits += nextDigit;
        }
        publicId = `xs-${digits}`;
    } while (Object.entries(database.users)
        .some(([userId, profile]) => userId !== exceptUserId && profile.publicId === publicId));
    return publicId;
}

function isValidPublicId(publicId) {
    return typeof publicId === 'string' &&
        /^xs-7\d{10}$/.test(publicId) &&
        !/(.)\1{4}/.test(publicId.slice(3));
}

function getTelegramWebhookSecret() {
    if (process.env.TELEGRAM_WEBHOOK_SECRET) {
        const secret = process.env.TELEGRAM_WEBHOOK_SECRET.trim();
        if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
            throw new Error('TELEGRAM_WEBHOOK_SECRET 32–256 ta harf, raqam, _ yoki - dan iborat bo‘lishi kerak.');
        }
        return secret;
    }
    if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
        throw new Error('Production uchun TELEGRAM_WEBHOOK_SECRET sozlanishi kerak.');
    }
    if (!database.telegramWebhookSecret) {
        database.telegramWebhookSecret = crypto.randomBytes(32).toString('hex');
        saveDatabase();
    }
    return database.telegramWebhookSecret;
}

io.use((socket, next) => {
    const result = verifyTelegramInitData(socket.handshake.auth && socket.handshake.auth.initData);
    if (result.error) {
        return next(new Error(result.error));
    }
    socket.data.telegramUser = result.user;
    socket.data.telegramStartParam = result.startParam;
    if (localDevMode) return next();
    starsStore.ensureSchema()
        .then(() => {
            const profile = getUserProfile(result.user, result.startParam);
            return starsStore.getWalletBalance(profile.id, profile.balance)
                .then(balance => {
                    profile.balance = balance;
                    socket.data.profile = profile;
                    next();
                });
        })
        .catch(error => {
            console.error('Socket foydalanuvchi hamyoni yuklanmadi:', error.message);
            next(new Error('Stars balansi vaqtincha yuklanmadi.'));
        });
});

async function changeWalletBalance(profile, delta) {
    if (!Number.isSafeInteger(delta)) throw new Error('Stars balans o‘zgarishi butun son bo‘lishi kerak.');
    if (localDevMode) {
        if (profile.balance + delta < 0) return null;
        profile.balance += delta;
        return profile.balance;
    }
    await starsStore.getWalletBalance(profile.id, profile.balance);
    const balance = await starsStore.changeWalletBalance(profile.id, delta);
    if (balance === null) return null;
    profile.balance = balance;
    return balance;
}

async function claimWalletReward(profile, amount, claimKey) {
    if (localDevMode) {
        const balance = await changeWalletBalance(profile, amount);
        return { applied: balance !== null };
    }

    const result = await starsStore.claimWalletReward(profile.id, amount, claimKey);
    profile.balance = result.balance === null
        ? await starsStore.getWalletBalance(profile.id, profile.balance)
        : result.balance;
    return { applied: result.applied };
}

app.get('/api/profile', authenticateRequest, (req, res) => {
    const profile = getUserProfile(req.telegramUser, req.telegramStartParam);
    res.json({
        username: profile.username,
        firstName: profile.firstName,
        lastName: profile.lastName,
        photoUrl: profile.photoUrl || '',
        publicId: profile.publicId,
        balance: profile.balance,
        bonusBalance: profile.bonusBalance || 0,
        lastFreeSpinAt: profile.lastFreeSpinAt || 0,
        usedPromos: profile.usedPromos,
        displayMode: profile.displayMode,
        customDisplayName: profile.customDisplayName,
        channelTaskClaimed: profile.channelTaskClaimed,
        referralCount: Object.values(database.users)
            .filter(user => user.referredBy === profile.id).length
    });
});

app.post('/api/profile/display', authenticateRequest, (req, res) => {
    const profile = getUserProfile(req.telegramUser, req.telegramStartParam);
    const displayMode = typeof req.body.displayMode === 'string' ? req.body.displayMode : '';
    const customDisplayName = typeof req.body.customDisplayName === 'string'
        ? req.body.customDisplayName.trim()
        : '';
    if (!['id', 'telegram', 'custom'].includes(displayMode)) {
        return res.status(400).json({ error: 'Ko‘rinish turini tanlang.' });
    }
    if (displayMode === 'custom' && !/^[\p{L}\p{N} _.-]{2,20}$/u.test(customDisplayName)) {
        return res.status(400).json({ error: 'Maxsus nom 2–20 ta harf, raqam yoki bo‘shliqdan iborat bo‘lsin.' });
    }

    profile.displayMode = displayMode;
    profile.customDisplayName = displayMode === 'custom' ? customDisplayName : '';
    saveDatabase();
    res.json({
        displayMode: profile.displayMode,
        customDisplayName: profile.customDisplayName
    });
});

app.get('/api/promos', (req, res) => {
    const promos = Object.entries(database.promocodes).map(([code, reward]) => ({
        code,
        reward,
        usedCount: Object.values(database.users)
            .filter(profile => Array.isArray(profile.usedPromos) && profile.usedPromos.includes(code)).length
    }));
    res.json(promos);
});

app.get('/api/case/config', (req, res) => {
    res.json({
        cost: casePaidCost,
        cooldownMs: caseFreeCooldownMs,
        freePrizes: caseFreePrizes.map(p => ({ reward: p.reward, chance: p.chancePercent })),
        paidPrizes: casePaidPrizes.map(p => ({ reward: p.reward, chance: p.chancePercent })),
        allPrizes: caseAllPrizes
    });
});

app.get('/api/spin-config', (req, res) => {
    res.json({
        cost: casePaidCost,
        cooldownMs: caseFreeCooldownMs,
        freePrizes: caseFreePrizes.map(p => ({ reward: p.reward, chance: p.chancePercent })),
        paidPrizes: casePaidPrizes.map(p => ({ reward: p.reward, chance: p.chancePercent })),
        allPrizes: caseAllPrizes,
        prizes: casePaidPrizes.map(p => ({ reward: p.reward, chance: p.chancePercent }))
    });
});

async function handleCaseSpin(req, res) {
    const profile = getUserProfile(req.telegramUser, req.telegramStartParam);
    const now = Date.now();
    const isFreeEligible = !profile.lastFreeSpinAt || (now - profile.lastFreeSpinAt) >= caseFreeCooldownMs;

    let mode = typeof req.body.mode === 'string' ? req.body.mode.toLowerCase() : '';
    if (!mode) {
        mode = isFreeEligible ? 'free' : 'paid';
    }

    if (mode === 'free') {
        if (!isFreeEligible) {
            const remainingMs = caseFreeCooldownMs - (now - profile.lastFreeSpinAt);
            const remainingHours = Math.ceil(remainingMs / (60 * 60 * 1000));
            return res.status(400).json({
                error: `Kunlik bepul aylanish ishlatilgan. Keyingi bepul aylanishga ${remainingHours} soat qoldi.`,
                remainingMs,
                nextFreeSpinAt: profile.lastFreeSpinAt + caseFreeCooldownMs,
                canPlayPaid: profile.balance >= casePaidCost
            });
        }

        const prize = rollCasePrize(true);
        profile.lastFreeSpinAt = now;

        const balance = await changeWalletBalance(profile, prize.reward);
        if (balance === null) {
            return res.status(500).json({ error: 'Yutuqni hisobga qo‘shib bo‘lmadi.' });
        }

        recordLedgerEntry(profile, 'spin_reward', prize.reward, profile.balance, 'case_free');
        saveDatabase();
        io.to(`user:${profile.id}`).emit('balance_update', { balance: profile.balance });

        return res.json({
            mode: 'free',
            reward: prize.reward,
            balance: profile.balance,
            bonusBalance: profile.bonusBalance || 0,
            lastFreeSpinAt: profile.lastFreeSpinAt,
            nextFreeSpinAt: profile.lastFreeSpinAt + caseFreeCooldownMs,
            message: `Tabriklaymiz! Bepul spin yutug‘i: +${prize.reward} ⭐`
        });
    }

    if (mode === 'paid') {
        if (profile.balance < casePaidCost) {
            return res.status(400).json({
                error: `Cases ochish uchun kamida ${casePaidCost} ⭐ kerak. Balansni to‘ldiring.`
            });
        }

        const prize = rollCasePrize(false);
        const balanceBefore = profile.balance;
        const netDelta = prize.reward - casePaidCost;
        const balance = await changeWalletBalance(profile, netDelta);
        if (balance === null) {
            return res.status(400).json({
                error: `Cases ochish uchun kamida ${casePaidCost} ⭐ kerak.`
            });
        }

        recordLedgerEntry(profile, 'game_spend', -casePaidCost, balanceBefore - casePaidCost, 'case_paid');
        recordLedgerEntry(profile, 'spin_reward', prize.reward, profile.balance, 'case_paid');
        recordAdminCommission(casePaidCost - prize.reward, 'case_paid');
        saveDatabase();
        io.to(`user:${profile.id}`).emit('balance_update', { balance: profile.balance });

        return res.json({
            mode: 'paid',
            cost: casePaidCost,
            reward: prize.reward,
            balance: profile.balance,
            bonusBalance: profile.bonusBalance || 0,
            lastFreeSpinAt: profile.lastFreeSpinAt || 0,
            nextFreeSpinAt: (profile.lastFreeSpinAt || 0) + caseFreeCooldownMs,
            message: `Tabriklaymiz! +${prize.reward} ⭐ yutdingiz!`
        });
    }

    return res.status(400).json({ error: 'Noto‘g‘ri rejim tanlandi (free yoki paid).' });
}

app.post('/api/case/spin', authenticateRequest, handleCaseSpin);
app.post('/api/spin', authenticateRequest, handleCaseSpin);

const activeThimblesGames = new Map();

app.post('/api/thimbles/play', authenticateRequest, async (req, res) => {
    const profile = getUserProfile(req.telegramUser, req.telegramStartParam);
    const bet = Math.floor(Number(req.body.bet));
    const mode = Number(req.body.mode) === 2 ? 2 : 1;
    const multiplier = mode === 1 ? 2.91 : 1.45;

    if (!Number.isSafeInteger(bet) || bet < 1 || bet > 100000) {
        return res.status(400).json({ error: 'Stavka 1 dan 100,000 ⭐ gacha bo‘lishi kerak.' });
    }

    if (profile.balance < bet) {
        return res.status(400).json({ error: 'Balansda yetarli ⭐ yo‘q. Profil orqali to‘ldiring.' });
    }

    let winningCups;
    if (mode === 1) {
        winningCups = [crypto.randomInt(3)];
    } else {
        const emptyCup = crypto.randomInt(3);
        winningCups = [0, 1, 2].filter(c => c !== emptyCup);
    }

    const gameId = crypto.randomUUID();
    activeThimblesGames.set(profile.id, {
        gameId,
        bet,
        mode,
        multiplier,
        winningCups,
        createdAt: Date.now()
    });

    const balanceBefore = profile.balance;
    const balance = await changeWalletBalance(profile, -bet);
    if (balance === null) {
        activeThimblesGames.delete(profile.id);
        return res.status(400).json({ error: 'Balansda yetarli ⭐ yo‘q.' });
    }

    recordLedgerEntry(profile, 'game_spend', -bet, balanceBefore - bet, `thimbles:${gameId}`);
    saveDatabase();
    io.to(`user:${profile.id}`).emit('balance_update', { balance: profile.balance });

    res.json({
        gameId,
        bet,
        mode,
        multiplier,
        balance: profile.balance,
        initialBallPositions: winningCups
    });
});

app.post('/api/thimbles/choose', authenticateRequest, async (req, res) => {
    const profile = getUserProfile(req.telegramUser, req.telegramStartParam);
    const gameId = typeof req.body.gameId === 'string' ? req.body.gameId : '';
    const chosenCup = Number(req.body.chosenCup);

    const activeGame = activeThimblesGames.get(profile.id);
    if (!activeGame || activeGame.gameId !== gameId) {
        return res.status(400).json({ error: 'Faol o‘yin topilmadi yoki vaqti o‘tgan. Qaytadan Play bosing.' });
    }

    if (![0, 1, 2].includes(chosenCup)) {
        return res.status(400).json({ error: 'Stakanlardan birini tanlang (0, 1 yoki 2).' });
    }

    activeThimblesGames.delete(profile.id);

    const won = activeGame.winningCups.includes(chosenCup);
    if (won) {
        const winAmount = Math.round(activeGame.bet * activeGame.multiplier);
        const balance = await changeWalletBalance(profile, winAmount);
        if (balance === null) {
            return res.status(500).json({ error: 'Yutuqni hisobga qo‘shib bo‘lmadi.' });
        }

        recordLedgerEntry(profile, 'thimbles_win', winAmount, profile.balance, `thimbles:${gameId}`);
        recordAdminCommission(activeGame.bet - winAmount, `thimbles:${gameId}`);
        saveDatabase();
        io.to(`user:${profile.id}`).emit('balance_update', { balance: profile.balance });

        return res.json({
            won: true,
            winAmount,
            multiplier: activeGame.multiplier,
            balance: profile.balance,
            winningCups: activeGame.winningCups,
            chosenCup,
            message: `🎉 Tabriklaymiz! +${winAmount.toLocaleString()} ⭐ (x${activeGame.multiplier}) yutdingiz!`
        });
    } else {
        recordAdminCommission(activeGame.bet, `thimbles:${gameId}`);
        saveDatabase();

        return res.json({
            won: false,
            winAmount: 0,
            multiplier: activeGame.multiplier,
            balance: profile.balance,
            winningCups: activeGame.winningCups,
            chosenCup,
            message: `Afsuski, bu stakanda shar yo‘q edi. Yana bir bor urinib ko‘ring!`
        });
    }
});

app.get('/api/slots-config', (req, res) => {
    res.json({
        bets: slotsBetOptions,
        rtp: Math.round(
            slotsOutcomes.reduce((total, outcome) => total + outcome.multiplier * outcome.weight, 0) /
            slotsOutcomeWeight * 100
        ),
        outcomes: slotsOutcomes.map(({ multiplier, weight }) => ({
            multiplier,
            chance: weight / slotsOutcomeWeight * 100
        }))
    });
});

app.post('/api/slots/spin', authenticateRequest, async (req, res) => {
    const profile = getUserProfile(req.telegramUser, req.telegramStartParam);
    const bet = Number(req.body.bet);
    const requestId = typeof req.body.requestId === 'string' ? req.body.requestId : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
        return res.status(400).json({ error: 'Slots so‘rovi identifikatori noto‘g‘ri.' });
    }
    if (!slotsBetOptions.includes(bet)) {
        return res.status(400).json({ error: 'Slots uchun stavka qiymatini tanlang.' });
    }

    const actionKey = `${profile.id}:${requestId}`;
    if (database.slotActions[actionKey]) {
        return res.json({ ...database.slotActions[actionKey], balance: profile.balance, replayed: true });
    }
    if (profile.balance < bet) {
        return res.status(400).json({ error: 'Balansda yetarli ⭐ yo‘q.' });
    }

    let roll = crypto.randomInt(slotsOutcomeWeight);
    const outcome = slotsOutcomes.find(item => {
        if (roll < item.weight) return true;
        roll -= item.weight;
        return false;
    });
    if (!outcome) {
        return res.status(500).json({ error: 'Slots natijasini aniqlab bo‘lmadi.' });
    }

    const reward = bet * outcome.multiplier;
    let result;
    if (localDevMode) {
        const balanceBefore = profile.balance;
        const balance = await changeWalletBalance(profile, reward - bet);
        if (balance === null) {
            return res.status(400).json({ error: 'Balansda yetarli ⭐ yo‘q.' });
        }
        recordLedgerEntry(profile, 'game_spend', -bet, balanceBefore - bet, `slots:${requestId}`);
        if (reward > 0) {
            recordLedgerEntry(profile, 'slots_reward', reward, profile.balance, `slots:${requestId}`);
        }
        recordAdminCommission(bet - reward, `slots:${requestId}`);
        result = { bet, multiplier: outcome.multiplier, reward, balance: profile.balance, requestId };
    } else {
        const settled = await starsStore.settleSlotsAction({
            userId: profile.id,
            requestId,
            bet,
            multiplier: outcome.multiplier,
            reward
        });
        if (!settled) {
            return res.status(400).json({ error: 'Balansda yetarli ⭐ yo‘q.' });
        }
        profile.balance = settled.balance;
        result = { ...settled, requestId };
        if (!settled.replayed) {
            recordLedgerEntry(profile, 'game_spend', -bet, profile.balance - reward, `slots:${requestId}`);
            if (reward > 0) {
                recordLedgerEntry(profile, 'slots_reward', reward, profile.balance, `slots:${requestId}`);
            }
            recordAdminCommission(bet - reward, `slots:${requestId}`);
        }
    }
    database.slotActions[actionKey] = result;
    saveDatabase();
    io.to(`user:${profile.id}`).emit('balance_update', { balance: profile.balance });
    res.json(result);
});

app.get('/api/admin/promos', authenticateAdmin, (req, res) => {
    const promos = Object.entries(database.promocodes).map(([code, reward]) => ({
        code,
        reward,
        usedCount: Object.values(database.users)
            .filter(profile => Array.isArray(profile.usedPromos) && profile.usedPromos.includes(code)).length
    }));
    res.json(promos);
});

app.get('/api/admin/ledger', authenticateAdmin, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const offset = Number(req.query.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) {
        return res.status(400).json({ error: 'To‘lovlar sahifasi noto‘g‘ri.' });
    }

    let payments;
    if (localDevMode) {
        payments = {
            paidStarsTotal: database.ledger
                .filter(entry => entry.type === 'telegram_payment')
                .reduce((total, entry) => total + entry.amount, 0),
            paymentCount: 0,
            payments: []
        };
    } else {
        try {
            payments = await starsStore.listPayments(100, offset);
        } catch (error) {
            console.error('Admin Stars to‘lovlari yuklanmadi:', error.message);
            return res.status(503).json({ error: 'Stars to‘lovlari jurnalini yuklab bo‘lmadi.' });
        }
    }

    const gameRewardsTotal = database.ledger
        .filter(entry => ['spin_reward', 'crash_win', 'slots_reward', 'pvp_win', 'thimbles_win'].includes(entry.type))
        .reduce((total, entry) => total + entry.amount, 0);
    const virtualStarsTurnover = database.ledger
        .filter(entry => entry.type === 'game_spend' && entry.amount < 0)
        .reduce((total, entry) => total - entry.amount, 0);
    const entries = database.ledger.slice(-500).reverse().map(entry => {
        const profile = database.users[entry.userId];
        const displayName = entry.displayName || (profile
            ? (profile.username
                ? `@${profile.username}`
                : [profile.firstName, profile.lastName].filter(Boolean).join(' '))
            : '');
        return {
            id: entry.id,
            publicId: entry.publicId || (profile && profile.publicId) || '',
            displayName,
            type: entry.type,
            amount: entry.amount,
            balanceAfter: entry.balanceAfter,
            reference: entry.reference,
            createdAt: entry.createdAt
        };
    });
    res.json({
        paidStarsTotal: payments.paidStarsTotal,
        paymentCount: payments.paymentCount,
        paymentPageSize: 100,
        payments: payments.payments,
        virtualStarsTurnover,
        gameRewardsTotal,
        adminCommissionBalance: database.adminCommissionBalance,
        entries
    });
});

function getTournamentWeek(now = Date.now()) {
    const tashkentDate = new Date(now + tashkentOffsetMs);
    const daysFromMonday = (tashkentDate.getUTCDay() + 6) % 7;
    const localMonday = Date.UTC(
        tashkentDate.getUTCFullYear(),
        tashkentDate.getUTCMonth(),
        tashkentDate.getUTCDate() - daysFromMonday
    );
    const startAt = localMonday - tashkentOffsetMs;
    return {
        key: new Date(localMonday).toISOString().slice(0, 10),
        startAt,
        endAt: startAt + tournamentWeekMs
    };
}

function getTournamentStandings(startAt, endAt) {
    const totals = new Map();
    database.ledger.forEach(entry => {
        if (!['game_spend', 'game_refund'].includes(entry.type) || !Number.isSafeInteger(entry.amount)) return;
        const createdAt = Date.parse(entry.createdAt);
        if (!Number.isFinite(createdAt) || createdAt < startAt || createdAt >= endAt) return;
        const profile = database.users[entry.userId];
        if (!profile) return;
        const current = totals.get(profile.id) || { profile, turnover: 0 };
        current.turnover -= entry.amount;
        totals.set(profile.id, current);
    });

    return Array.from(totals.values())
        .map(({ profile, turnover }) => ({ profile, turnover: Math.max(0, turnover) }))
        .filter(standing => standing.turnover > 0)
        .sort((a, b) => b.turnover - a.turnover || a.profile.publicId.localeCompare(b.profile.publicId));
}

async function settleTournamentWeek(startAt) {
    const key = new Date(startAt + tashkentOffsetMs).toISOString().slice(0, 10);
    if (database.tournamentPayouts[key]) {
        database.lastTournamentProcessedWeekStart = Math.max(
            Number(database.lastTournamentProcessedWeekStart) || 0,
            startAt + tournamentWeekMs
        );
        saveDatabase();
        return database.tournamentPayouts[key];
    }

    const standings = getTournamentStandings(startAt, startAt + tournamentWeekMs);
    const winners = [];
    for (const [index, standing] of standings.slice(0, tournamentPrizes.length).entries()) {
        const rank = index + 1;
        const reward = tournamentPrizes[index];
        const profile = standing.profile;
        const credit = await claimWalletReward(
            profile,
            reward,
            `tournament:${key}:${profile.id}:${rank}`
        );
        if (credit.applied) {
            recordLedgerEntry(profile, 'tournament_reward', reward, profile.balance, `tournament:${key}:${rank}`);
        }
        winners.push({
            rank,
            ...getPublicPlayer(profile),
            turnover: standing.turnover,
            reward
        });
    }
    const payout = { weekKey: key, settledAt: new Date().toISOString(), winners };
    database.tournamentPayouts[key] = payout;
    database.lastTournamentProcessedWeekStart = startAt + tournamentWeekMs;
    saveDatabase();
    winners.forEach(winner => {
        const profile = standings[winner.rank - 1].profile;
        io.to(`user:${profile.id}`).emit('balance_update', { balance: profile.balance });
    });
    return payout;
}

async function processTournamentPayouts(now = Date.now()) {
    const currentWeek = getTournamentWeek(now);
    if (!Number.isSafeInteger(database.lastTournamentProcessedWeekStart)) {
        database.lastTournamentProcessedWeekStart = currentWeek.startAt;
        saveDatabase();
    }

    let weekStart = database.lastTournamentProcessedWeekStart;
    while (weekStart + tournamentWeekMs <= currentWeek.startAt) {
        await settleTournamentWeek(weekStart);
        weekStart += tournamentWeekMs;
    }
}

app.get('/api/tournament', authenticateRequest, (req, res) => {
    const profile = getUserProfile(req.telegramUser, req.telegramStartParam);
    const week = getTournamentWeek();
    const standings = getTournamentStandings(week.startAt, week.endAt);
    const players = standings.slice(0, 10).map((standing, index) => ({
        rank: index + 1,
        ...getPublicPlayer(standing.profile),
        turnover: standing.turnover,
        reward: tournamentPrizes[index] || 0
    }));
    const myStandingIndex = standings.findIndex(standing => standing.profile.id === profile.id);
    const completedWeeks = Object.values(database.tournamentPayouts)
        .sort((a, b) => b.weekKey.localeCompare(a.weekKey));
    res.json({
        weekKey: week.key,
        startsAt: new Date(week.startAt).toISOString(),
        endsAt: new Date(week.endAt).toISOString(),
        balance: profile.balance,
        prizes: tournamentPrizes,
        players,
        myStanding: myStandingIndex < 0
            ? null
            : { rank: myStandingIndex + 1, turnover: standings[myStandingIndex].turnover },
        lastCompleted: completedWeeks[0] || null
    });
});

app.post('/api/admin/promos', authenticateAdmin, (req, res) => {
    const code = typeof req.body.code === 'string' ? req.body.code.trim().toUpperCase() : '';
    const reward = Number(req.body.reward);
    if (!/^[A-Z0-9_-]{3,32}$/.test(code) ||
        !Number.isSafeInteger(reward) || reward < 1 || reward > 100000) {
        return res.status(400).json({
            error: 'Promokod 3–32 ta harf/raqamdan iborat, yulduz miqdori esa 1–100000 oralig‘ida bo‘lishi kerak.'
        });
    }

    database.promocodes[code] = reward;
    saveDatabase();
    res.json({ success: true, message: `${code} promokodi saqlandi.` });
});

app.delete('/api/admin/promos/:code', authenticateAdmin, (req, res) => {
    const code = req.params.code.toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(database.promocodes, code)) {
        return res.status(404).json({ error: 'Promokod topilmadi.' });
    }

    delete database.promocodes[code];
    saveDatabase();
    res.json({ success: true, message: `${code} promokodi o‘chirildi.` });
});

app.post('/api/apply-promo', authenticateRequest, async (req, res) => {
    const profile = getUserProfile(req.telegramUser, req.telegramStartParam);
    const code = typeof req.body.code === 'string' ? req.body.code.trim().toUpperCase() : '';

    if (!code) {
        return res.json({ success: false, message: 'Promokod kiritilmadi!' });
    }

    if (profile.usedPromos.includes(code)) {
        return res.json({ success: false, message: 'Bu promokod allaqachon ishlatilgan!' });
    }

    if (!Object.prototype.hasOwnProperty.call(database.promocodes, code)) {
        return res.json({ success: false, message: 'Bunday promokod mavjud emas yoki eskirgan!' });
    }

    const reward = database.promocodes[code];
    const credit = await claimWalletReward(profile, reward, `promo:${profile.id}:${code}`);
    if (!credit.applied) {
        if (!profile.usedPromos.includes(code)) profile.usedPromos.push(code);
        saveDatabase();
        return res.json({ success: false, message: 'Bu promokod allaqachon ishlatilgan!' });
    }
    profile.usedPromos.push(code);
    recordLedgerEntry(profile, 'promo_reward', reward, profile.balance, code);
    saveDatabase();
    return res.json({
        success: true,
        newBalance: profile.balance,
        reward,
        message: `Tabriklaymiz! +${reward} ⭐ qo'shildi.`
    });
});

async function callTelegramApi(method, body) {
    const botToken = getConfiguredBotToken();
    const tokenError = getBotTokenError();
    if (tokenError) throw new Error(tokenError);

    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
        throw new Error(result.description || `Telegram API so‘rovi bajarilmadi (${method}).`);
    }
    return result.result;
}

function getPublicUrl() {
    return process.env.PUBLIC_URL ||
        process.env.RENDER_EXTERNAL_URL ||
        (process.env.VERCEL_PROJECT_PRODUCTION_URL
            ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
            : process.env.RAILWAY_PUBLIC_DOMAIN
                ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
                : process.env.RAILWAY_ENVIRONMENT
                    ? 'https://xs-case-production.up.railway.app'
                    : '');
}

async function setTelegramWebhook() {
    const publicUrl = getPublicUrl();
    if (!publicUrl) throw new Error('PUBLIC_URL yoki hosting public URL sozlanmagan.');
    const tokenError = getBotTokenError();
    if (tokenError) throw new Error(tokenError);
    await callTelegramApi('setWebhook', {
        url: `${publicUrl.replace(/\/+$/, '')}/api/telegram/webhook`,
        secret_token: getTelegramWebhookSecret(),
        allowed_updates: ['message', 'pre_checkout_query']
    });
}

app.post('/api/setup-webhook', authenticateAdmin, async (req, res) => {
    if (localDevMode) {
        return res.status(503).json({ error: 'Webhookni production muhitida sozlang.' });
    }
    try {
        await setTelegramWebhook();
        res.json({ success: true, message: 'Telegram webhook sozlandi.' });
    } catch (error) {
        console.error('Telegram webhook sozlanmadi:', error.message);
        res.status(503).json({ error: error.message });
    }
});

let cachedBotUsername = (process.env.BOT_USERNAME || '').replace(/^@/, '');
let botUsernameRequest = null;
async function getBotUsername() {
    if (cachedBotUsername) return cachedBotUsername;
    if (!botUsernameRequest) {
        botUsernameRequest = callTelegramApi('getMe', {}).then(bot => {
            if (!bot || typeof bot.username !== 'string' || !/^[A-Za-z0-9_]{5,32}$/.test(bot.username)) {
                throw new Error('Telegram bot username aniqlanmadi.');
            }
            cachedBotUsername = bot.username;
            return cachedBotUsername;
        }).catch(error => {
            botUsernameRequest = null;
            throw error;
        });
    }
    return botUsernameRequest;
}

app.get('/api/referral-link', authenticateRequest, async (req, res) => {
    const profile = getUserProfile(req.telegramUser, req.telegramStartParam);
    if (localDevMode) {
        return res.json({
            inviteLink: '',
            referralCount: Object.values(database.users)
                .filter(user => user.referredBy === profile.id).length,
            localDevMode: true
        });
    }

    try {
        const botUsername = await getBotUsername();
        const referralCount = Object.values(database.users)
            .filter(user => user.referredBy === profile.id).length;
        res.json({
            inviteLink: `https://t.me/${botUsername}?startapp=ref_${profile.id}`,
            referralCount
        });
    } catch (error) {
        console.error('Taklif havolasi yaratilmadi:', error.message);
        res.status(502).json({ error: 'Taklif havolasini yaratib bo‘lmadi. Bot username sozlamasini tekshiring.' });
    }
});

app.post('/api/tasks/check-channel', authenticateRequest, async (req, res) => {
    if (localDevMode) {
        return res.status(503).json({
            error: 'Kanal obunasini tekshirish uchun Telegram bot tokeni kerak; local rejimda bu xizmat o‘chiq.'
        });
    }

    const profile = getUserProfile(req.telegramUser, req.telegramStartParam);
    let member;
    try {
        member = await callTelegramApi('getChatMember', {
            chat_id: channelUsername,
            user_id: Number(profile.id)
        });
    } catch (error) {
        console.error('Telegram kanal obunasi tekshirilmadi:', error.message);
        return res.status(502).json({
            error: 'Kanalni tekshirib bo‘lmadi. Bot @xscase kanalida admin ekanini tekshiring.'
        });
    }

    const subscribed = ['creator', 'administrator', 'member'].includes(member.status) ||
        (member.status === 'restricted' && member.is_member === true);
    if (!subscribed) {
        return res.json({
            subscribed: false,
            claimed: profile.channelTaskClaimed,
            balance: profile.balance
        });
    }

    let rewardGranted = false;
    if (!profile.channelTaskClaimed) {
        const credit = await claimWalletReward(profile, 1, `channel:${profile.id}:${channelUsername}`);
        profile.channelTaskClaimed = true;
        if (credit.applied) {
            recordLedgerEntry(profile, 'channel_subscription_reward', 1, profile.balance, channelUsername);
        }
        saveDatabase();
        io.to(`user:${profile.id}`).emit('balance_update', { balance: profile.balance });
        rewardGranted = credit.applied;
    }
    return res.json({
        subscribed: true,
        claimed: profile.channelTaskClaimed,
        rewardGranted,
        balance: profile.balance
    });
});

app.post('/api/create-invoice', authenticateRequest, async (req, res) => {
    if (localDevMode) {
        return res.status(503).json({
            error: 'Telegram Stars to‘lovlari local rejimda o‘chiq; faqat o‘yinlar uchun virtual balans ishlatiladi.'
        });
    }

    const amount = Number(req.body && req.body.amount);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 10000) {
        return res.status(400).json({ error: 'To‘lov miqdori 1–10000 Stars oralig‘ida bo‘lishi kerak.' });
    }

    const tokenError = getBotTokenError();
    if (tokenError) return res.status(503).json({ error: tokenError });

    const profile = getUserProfile(req.telegramUser, req.telegramStartParam);
    const payload = createInvoicePayload(profile.id, amount, getConfiguredBotToken());
    try {
        await starsStore.createPendingPayment({
            payload,
            userId: profile.id,
            username: profile.username || '',
            displayName: profile.username
                ? `@${profile.username}`
                : [profile.firstName, profile.lastName].filter(Boolean).join(' '),
            publicId: profile.publicId,
            referrerId: profile.referredBy || '',
            amount
        });
        const invoiceLink = await callTelegramApi('createInvoiceLink', {
            title: `${amount} Stars`,
            description: `XS Case balansiga ${amount} Telegram Stars qo‘shish`,
            payload,
            provider_token: '',
            currency: 'XTR',
            prices: [{ label: `${amount} Stars`, amount }]
        });

        res.json({ invoiceLink });
    } catch (error) {
        try {
            await starsStore.deletePendingPayment(payload);
        } catch (cleanupError) {
            console.error('Yaratilmagan invoice yozuvi o‘chirilmadi:', cleanupError.message);
        }
        console.error('Telegram invoice yaratilmadi:', error.message);
        const status = error.message.includes('DATABASE_URL') ? 503 : 502;
        res.status(status).json({
            error: status === 503
                ? 'To‘lovlar bazasi sozlanmagan. Administrator DATABASE_URL ni tekshirsin.'
                : `Telegram to‘lov havolasini yaratib bo‘lmadi: ${error.message}`
        });
    }
});

async function getPendingStarsPayment(payload) {
    let pending = await starsStore.getPendingPayment(payload);
    if (pending || typeof payload !== 'string') return pending;

    const legacy = database.pendingPayments[payload];
    if (!legacy || typeof legacy.userId !== 'string' ||
        !Number.isSafeInteger(Number(legacy.amount)) || Number(legacy.amount) < 1) {
        return null;
    }
    const profile = database.users[legacy.userId];
    await starsStore.createPendingPayment({
        payload,
        userId: legacy.userId,
        username: profile ? profile.username || '' : '',
        displayName: profile
            ? (profile.username
                ? `@${profile.username}`
                : [profile.firstName, profile.lastName].filter(Boolean).join(' '))
            : '',
        publicId: profile ? profile.publicId : '',
        referrerId: profile ? profile.referredBy || '' : '',
        amount: Number(legacy.amount)
    });
    return starsStore.getPendingPayment(payload);
}

function hasValidWebhookSecret(req) {
    let expectedSecret;
    try {
        expectedSecret = getTelegramWebhookSecret();
    } catch (error) {
        return false;
    }
    const provided = Buffer.from(req.get('x-telegram-bot-api-secret-token') || '');
    const expected = Buffer.from(expectedSecret);
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

app.post('/api/telegram/webhook', async (req, res) => {
    if (localDevMode) {
        return res.status(404).json({ error: 'Telegram webhook local rejimda ishlamaydi.' });
    }

    if (!hasValidWebhookSecret(req)) {
        return res.status(401).json({ error: 'Webhook tasdiqlanmadi.' });
    }

    try {
        await starsStore.ensureSchema();
        const update = req.body || {};
        if (update.pre_checkout_query) {
            const query = update.pre_checkout_query;
            const pending = query && typeof query.invoice_payload === 'string'
                ? await getPendingStarsPayment(query.invoice_payload)
                : null;
            const valid = pending &&
                Date.parse(pending.expiresAt) > Date.now() &&
                String(query.from && query.from.id) === pending.userId &&
                query.currency === 'XTR' &&
                query.total_amount === Number(pending.amount) &&
                hasValidInvoicePayload(
                    query.invoice_payload,
                    pending.userId,
                    pending.amount,
                    getConfiguredBotToken()
                );
            await callTelegramApi('answerPreCheckoutQuery', valid
                ? { pre_checkout_query_id: query.id, ok: true }
                : {
                    pre_checkout_query_id: query.id,
                    ok: false,
                    error_message: 'To‘lov ma’lumotlari noto‘g‘ri yoki eskirgan.'
                });
            return res.json({ ok: true });
        }

        const message = update.message;
        const payment = message && message.successful_payment;
        if (!payment) return res.json({ ok: true });

        const chargeId = payment.telegram_payment_charge_id;
        if (typeof chargeId !== 'string' || !chargeId) {
            console.error('Stars to‘lovi charge IDsiz keldi.');
            return res.status(400).json({ error: 'To‘lov identifikatori topilmadi.' });
        }
        if (await starsStore.hasProcessedCharge(chargeId)) return res.json({ ok: true });

        const pending = typeof payment.invoice_payload === 'string'
            ? await getPendingStarsPayment(payment.invoice_payload)
            : null;
        if (!pending ||
            String(message.from && message.from.id) !== pending.userId ||
            payment.currency !== 'XTR' ||
            Number(payment.total_amount) !== Number(pending.amount) ||
            !hasValidInvoicePayload(
                payment.invoice_payload,
                pending.userId,
                pending.amount,
                getConfiguredBotToken()
            )) {
            console.error('Stars to‘lovi invoice ma’lumotlari bilan mos kelmadi:', chargeId);
            return res.json({ ok: true });
        }

        const result = await starsStore.creditPayment({
            chargeId,
            payload: pending.payload,
            userId: pending.userId,
            amount: Number(pending.amount),
            paidAmount: Number(payment.total_amount),
            currency: payment.currency,
            referralRewardPercent
        });
        if (!result) return res.json({ ok: true });

        let profile = database.users[pending.userId];
        if (!profile) {
            profile = getUserProfile({
                id: Number(pending.userId),
                username: pending.username,
                first_name: pending.displayName && !pending.username ? pending.displayName : '',
                last_name: ''
            }, '');
            profile.publicId = pending.publicId || profile.publicId;
        }
        profile.balance = Number(result.balanceAfter);
        recordLedgerEntry(profile, 'telegram_payment', Number(result.creditedStars), profile.balance, chargeId);
        database.processedPayments[chargeId] = {
            userId: pending.userId,
            amount: Number(result.creditedStars),
            processedAt: Date.now()
        };
        delete database.pendingPayments[pending.payload];
        saveDatabase();
        io.to(`user:${pending.userId}`).emit('balance_update', { balance: profile.balance });

        if (result.referralUserId) {
            const referrer = database.users[result.referralUserId];
            if (referrer) {
                referrer.balance = Number(result.referralBalance);
                recordLedgerEntry(
                    referrer,
                    'referral_reward',
                    Number(result.referralReward),
                    referrer.balance,
                    `referral:${chargeId}`
                );
                io.to(`user:${referrer.id}`).emit('balance_update', { balance: referrer.balance });
            }
        }
        return res.json({ ok: true });
    } catch (error) {
        console.error('Telegram Stars webhook ishlanmadi:', error.message);
        return res.status(503).json({ error: 'To‘lovni qayta ishlash vaqtincha bajarilmadi.' });
    }
});

// --- CRASH O'YINI MANTIQI ---
let multiplier = 1.00;
let gameState = 'waiting'; 
let gameInterval = null;
let countdownInterval = null;
let countdown = 5;
let lastCrashPoint = 1;
let roundBets = new Map();
let queuedBets = new Map();
let roundId = crypto.randomUUID();
let pvpCountdownInterval = null;
let pvpSpinTimeout = null;

function getPvpState() {
    const round = database.pvpRound;
    if (!round) {
        return { phase: 'idle', countdown: 0, totalPot: 0, bets: [], result: null };
    }

    const bets = Array.isArray(round.bets) ? round.bets : [];
    return {
        phase: round.phase,
        roundId: round.id,
        countdown: round.phase === 'waiting'
            ? Math.max(0, Math.ceil((round.deadline - Date.now()) / 1000))
            : 0,
        totalPot: bets.reduce((total, bet) => total + bet.amount, 0),
        bets: bets.map(bet => ({
            ...(database.users[bet.userId]
                ? getPublicPlayer(database.users[bet.userId])
                : { idSuffix: bet.publicId.slice(-4), displayName: bet.publicId.slice(-4), initials: bet.initials, photoUrl: bet.photoUrl || '' }),
            amount: bet.amount,
            status: bet.status
        })),
        spinDurationMs: round.spinDurationMs || 0,
        winnerIndex: round.phase === 'spinning' && Number.isInteger(round.winnerIndex)
            ? round.winnerIndex
            : null,
        result: round.result || null
    };
}

function broadcastPvpState() {
    io.emit('pvp_state', getPvpState());
}

function emitPvpPlayerState(userId) {
    const round = database.pvpRound;
    const bet = round && Array.isArray(round.bets)
        ? round.bets.find(item => item.userId === userId && item.status === 'active')
        : null;
    io.to(`user:${userId}`).emit('pvp_player_state', {
        hasBet: Boolean(bet),
        amount: bet ? bet.amount : null
    });
}

function createPvpRound() {
    return {
        id: crypto.randomUUID(),
        phase: 'waiting',
        deadline: Date.now() + pvpLobbySeconds * 1000,
        bets: [],
        result: null
    };
}

async function refundPvpRound(round, reason) {
    for (const bet of round.bets) {
        if (bet.status !== 'active') continue;
        const profile = database.users[bet.userId];
        if (!profile) continue;
        const balance = await changeWalletBalance(profile, bet.amount);
        if (balance === null) throw new Error('PvP stavkasini qaytarib bo‘lmadi.');
        bet.status = 'refunded';
        recordLedgerEntry(profile, 'game_refund', bet.amount, profile.balance, `pvp:${round.id}`);
        io.to(`user:${profile.id}`).emit('balance_update', { balance: profile.balance });
        emitPvpPlayerState(profile.id);
    }
    round.phase = 'cancelled';
    round.result = { message: reason };
    saveDatabase();
    broadcastPvpState();
}

async function settlePvpRound(round) {
    if (database.pvpRound !== round || round.phase !== 'spinning') return;
    const winner = round.bets.find(bet => bet.userId === round.winnerUserId);
    const winnerProfile = winner && database.users[winner.userId];
    if (!winner || !winnerProfile) {
        await refundPvpRound(round, 'Raundni yakunlab bo‘lmadi; stavkalar qaytarildi.');
        return;
    }

    const totalPot = round.bets.reduce((total, bet) => total + bet.amount, 0);
    const opponentsPot = totalPot - winner.amount;
    const opponentsShare = Math.floor(opponentsPot * pvpWinnerSharePercent / 100);
    const payout = winner.amount + opponentsShare;
    const commission = opponentsPot - opponentsShare;
    const balance = await changeWalletBalance(winnerProfile, payout);
    if (balance === null) throw new Error('PvP yutug‘ini balansga yozib bo‘lmadi.');
    recordLedgerEntry(winnerProfile, 'pvp_win', payout, winnerProfile.balance, `pvp:${round.id}`);
    recordAdminCommission(commission, `pvp:${round.id}`);
    round.bets.forEach(bet => {
        bet.status = bet.userId === winner.userId ? 'won' : 'lost';
    });
    round.phase = 'finished';
    round.result = {
        winnerSuffix: winner.publicId.slice(-4),
        payout,
        commission,
        totalPot,
        completedAt: Date.now(),
        playerResults: round.bets.map(bet => ({
            idSuffix: bet.publicId.slice(-4),
            displayName: bet.displayName || bet.publicId.slice(-4),
            photoUrl: bet.photoUrl || '',
            amount: bet.amount,
            payout: bet.userId === winner.userId ? payout : 0,
            winChance: bet.amount / totalPot * 100
        }))
    };
    delete round.winnerUserId;
    saveDatabase();
    io.to(`user:${winner.userId}`).emit('balance_update', { balance: winnerProfile.balance });
    round.bets.forEach(bet => emitPvpPlayerState(bet.userId));
    broadcastPvpState();
}

function startPvpRound(round) {
    if (database.pvpRound !== round || round.phase !== 'waiting') return;
    if (round.bets.length < 2) {
        refundPvpRound(round, 'Kamida 2 o‘yinchi kerak edi; stavka qaytarildi.')
            .catch(error => console.error('PvP stavkasi qaytarilmadi:', error.message));
        return;
    }

    const totalPot = round.bets.reduce((total, bet) => total + bet.amount, 0);
    if (!Number.isSafeInteger(totalPot) || totalPot < 1 || totalPot >= 2 ** 48) {
        refundPvpRound(round, 'All miqdori noto‘g‘ri; stavka qaytarildi.')
            .catch(error => console.error('PvP stavkasi qaytarilmadi:', error.message));
        return;
    }
    let winningTicket = crypto.randomInt(totalPot);
    const winner = round.bets.find(bet => {
        if (winningTicket < bet.amount) return true;
        winningTicket -= bet.amount;
        return false;
    });
    if (!winner) {
        refundPvpRound(round, 'G‘olibni aniqlab bo‘lmadi; stavka qaytarildi.')
            .catch(error => console.error('PvP stavkasi qaytarilmadi:', error.message));
        return;
    }

    round.phase = 'spinning';
    round.winnerUserId = winner.userId;
    round.winnerPublicId = winner.publicId;
    round.winnerIndex = round.bets.indexOf(winner);
    round.spinDurationMs = pvpSpinDurationMs;
    saveDatabase();
    broadcastPvpState();
    pvpSpinTimeout = setTimeout(() => {
        settlePvpRound(round).catch(error => console.error('PvP raundi yakunlanmadi:', error.message));
    }, pvpSpinDurationMs);
}

function startPvpCountdown(round) {
    if (pvpCountdownInterval) clearInterval(pvpCountdownInterval);
    pvpCountdownInterval = setInterval(() => {
        if (database.pvpRound !== round || round.phase !== 'waiting') {
            clearInterval(pvpCountdownInterval);
            pvpCountdownInterval = null;
            return;
        }
        broadcastPvpState();
        if (Date.now() >= round.deadline) {
            clearInterval(pvpCountdownInterval);
            pvpCountdownInterval = null;
            startPvpRound(round);
        }
    }, 1000);
}

async function placePvpBet(socket, profile, data) {
    const amount = Number(data && data.amount);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > pvpMaxBet) {
        return socket.emit('pvp_bet_rejected', { error: `Stavka 1–${pvpMaxBet} ⭐ oralig‘ida bo‘lishi kerak.` });
    }
    let round = database.pvpRound;
    if (!round || round.phase === 'finished' || round.phase === 'cancelled') {
        round = createPvpRound();
        database.pvpRound = round;
    }
    if (round.phase !== 'waiting' || Date.now() >= round.deadline) {
        return socket.emit('pvp_bet_rejected', { error: 'Raund yopildi. Keyingi PvP raundini kuting.' });
    }
    const existingBet = round.bets.find(bet => bet.userId === profile.id);
    const currentAmount = existingBet ? existingBet.amount : 0;
    if (currentAmount + amount > pvpMaxBet) {
        return socket.emit('pvp_bet_rejected', { error: `Bir raunddagi stavkangiz ${pvpMaxBet} ⭐ dan oshmasin.` });
    }
    if (profile.balance < amount) {
        return socket.emit('pvp_bet_rejected', { error: 'Balansda yetarli ⭐ yo‘q.' });
    }
    if (!existingBet && round.bets.length >= pvpMaxPlayers) {
        return socket.emit('pvp_bet_rejected', { error: 'Raunddagi o‘yinchi limiti to‘ldi.' });
    }

    const balance = await changeWalletBalance(profile, -amount);
    if (balance === null) {
        return socket.emit('pvp_bet_rejected', { error: 'Balansda yetarli ⭐ yo‘q.' });
    }
    if (existingBet) {
        existingBet.amount += amount;
    } else {
        round.bets.push({
            userId: profile.id,
            publicId: profile.publicId,
            displayName: getPublicPlayerName(profile),
            amount,
            initials: getPublicPlayer(profile).initials,
            photoUrl: profile.photoUrl || '',
            status: 'active'
        });
    }
    recordLedgerEntry(profile, 'game_spend', -amount, profile.balance, `pvp:${round.id}`);
    saveDatabase();
    io.to(`user:${profile.id}`).emit('balance_update', { balance: profile.balance });
    io.to(`user:${profile.id}`).emit('pvp_bet_accepted', {
        amount,
        totalAmount: existingBet ? existingBet.amount : amount
    });
    if (round.bets.length === 1) startPvpCountdown(round);
    broadcastPvpState();
}

async function recoverInterruptedPvpRound() {
    const round = database.pvpRound;
    if (!round || (round.phase !== 'waiting' && round.phase !== 'spinning') || !Array.isArray(round.bets)) return;
    for (const bet of round.bets) {
        if (bet.status !== 'active') continue;
        const profile = database.users[bet.userId];
        if (!profile) continue;
        const balance = await changeWalletBalance(profile, bet.amount);
        if (balance === null) throw new Error('Qayta tiklangan PvP stavkasini qaytarib bo‘lmadi.');
        bet.status = 'refunded';
        recordLedgerEntry(profile, 'game_refund', bet.amount, profile.balance, `pvp:${round.id}`);
    }
    round.phase = 'cancelled';
    round.result = { message: 'Server qayta ishga tushdi; stavkalar qaytarildi.' };
    saveDatabase();
}

function getRoundBetsUpdate() {
    const bets = Array.from(roundBets.values());
    return {
        totalPlayers: bets.length,
        activePlayers: bets.filter(bet => bet.status === 'active').length,
        totalStaked: bets.reduce((total, bet) => total + bet.amount, 0),
        bets: bets.map(bet => ({
            idSuffix: bet.publicId.slice(-4),
            displayName: bet.displayName || bet.publicId.slice(-4),
            initials: bet.initials || bet.publicId.slice(-2),
            photoUrl: bet.photoUrl || '',
            amount: bet.amount,
            status: bet.status,
            multiplier: bet.multiplier,
            winAmount: bet.winAmount
        })).reverse()
    };
}

function broadcastRoundBets() {
    io.emit('round_bets_update', getRoundBetsUpdate());
}

async function acceptQueuedBets() {
    const acceptedBets = [];
    const rejectedBets = [];

    for (const [userId, queuedBet] of queuedBets) {
        const profile = database.users[userId];
        if (profile && profile.balance >= queuedBet.amount) {
            const balance = await changeWalletBalance(profile, -queuedBet.amount);
            if (balance === null) {
                rejectedBets.push(userId);
                continue;
            }
            recordLedgerEntry(profile, 'game_spend', -queuedBet.amount, profile.balance, `crash:${roundId}`);
            roundBets.set(userId, {
                publicId: profile.publicId,
                displayName: getPublicPlayerName(profile),
                initials: getPublicPlayer(profile).initials,
                photoUrl: profile.photoUrl || '',
                amount: queuedBet.amount,
                status: 'active',
                multiplier: null,
                winAmount: 0
            });
            acceptedBets.push({ userId, amount: queuedBet.amount, balance: profile.balance });
        } else {
            rejectedBets.push(userId);
        }
    }

    queuedBets.clear();
    if (acceptedBets.length) saveDatabase();

    acceptedBets.forEach(({ userId, amount, balance }) => {
        io.to(`user:${userId}`).emit('balance_update', { balance });
        io.to(`user:${userId}`).emit('bet_accepted', { amount, queued: true });
    });
    rejectedBets.forEach(userId => {
        io.to(`user:${userId}`).emit('bet_rejected', {
            error: 'Balansda yetarli ⭐ qolmagani uchun keyingi raund stavkasi qabul qilinmadi.'
        });
    });
}

async function startNewGame() {
    if (countdownInterval) clearInterval(countdownInterval);
    gameState = 'waiting';
    multiplier = 1.00;
    countdown = 5;
    roundId = crypto.randomUUID();
    roundBets = new Map();
    io.emit('game_waiting', { countdown, roundId });
    await acceptQueuedBets();
    broadcastRoundBets();
    countdownInterval = setInterval(() => {
        countdown -= 1;
        if (countdown > 0) {
            io.emit('game_waiting', { countdown, roundId });
            return;
        }
        clearInterval(countdownInterval);
        countdownInterval = null;
        gameState = 'running';
        const crashPoint = crypto.randomInt(110, 1201) / 100;
        io.emit('game_started', { multiplier, roundId });
        
        gameInterval = setInterval(() => {
            multiplier += 0.02;
            
            if (multiplier >= crashPoint) {
                clearInterval(gameInterval);
                gameState = 'crashed';
                lastCrashPoint = crashPoint;
                roundBets.forEach(bet => {
                    if (bet.status === 'active') {
                        bet.status = 'lost';
                        bet.multiplier = crashPoint;
                        bet.winAmount = 0;
                    }
                });
                broadcastRoundBets();
                io.emit('game_crashed', { multiplier: crashPoint, roundId });
                setTimeout(() => {
                    startNewGame().catch(error => console.error('Crash raundi boshlanmadi:', error.message));
                }, 5000);
            } else {
                io.emit('multiplier_update', { multiplier: parseFloat(multiplier.toFixed(2)) });
            }
        }, 100);
    }, 1000);
}

io.on('connection', (socket) => {
    console.log('Foydalanuvchi ulandi:', socket.id);
    const profile = socket.data.profile || getUserProfile(socket.data.telegramUser, socket.data.telegramStartParam);
    socket.join(`user:${profile.id}`);

    if (gameState === 'waiting') {
        socket.emit('game_waiting', { countdown, roundId });
    } else if (gameState === 'running') {
        socket.emit('game_started', { multiplier, roundId });
        socket.emit('multiplier_update', { multiplier });
    } else {
        socket.emit('game_crashed', { multiplier: lastCrashPoint, roundId });
    }
    socket.emit('round_bets_update', getRoundBetsUpdate());
    socket.emit('pvp_state', getPvpState());
    const pvpBet = database.pvpRound && database.pvpRound.bets
        ? database.pvpRound.bets.find(bet => bet.userId === profile.id && bet.status === 'active')
        : null;
    socket.emit('pvp_player_state', {
        hasBet: Boolean(pvpBet),
        amount: pvpBet ? pvpBet.amount : null
    });
    const existingBet = roundBets.get(profile.id);
    const queuedBet = queuedBets.get(profile.id);
    socket.emit('player_bet_state', {
        hasBet: Boolean(existingBet && existingBet.status === 'active'),
        hasPlayedRound: Boolean(existingBet),
        hasQueuedBet: Boolean(queuedBet),
        amount: existingBet ? existingBet.amount : queuedBet ? queuedBet.amount : null
    });

    const acceptBet = async amount => {
        if (gameState !== 'waiting') {
            return socket.emit('bet_rejected', { error: 'Raund boshlangan. Keyingi raundni kuting.' });
        }
        if (roundBets.has(profile.id) || queuedBets.has(profile.id)) {
            return socket.emit('bet_rejected', { error: 'Bu raundga stavka allaqachon qo‘yilgan.' });
        }
        if (!Number.isSafeInteger(amount) || amount < 1) {
            return socket.emit('bet_rejected', { error: 'Stavka miqdori noto‘g‘ri.' });
        }
        if (profile.balance < amount) {
            return socket.emit('bet_rejected', { error: 'Balansda yetarli ⭐ yo‘q.' });
        }

        const balance = await changeWalletBalance(profile, -amount);
        if (balance === null) {
            return socket.emit('bet_rejected', { error: 'Balansda yetarli ⭐ yo‘q.' });
        }
        roundBets.set(profile.id, {
            publicId: profile.publicId,
            displayName: getPublicPlayerName(profile),
            initials: getPublicPlayer(profile).initials,
            photoUrl: profile.photoUrl || '',
            amount,
            status: 'active',
            multiplier: null,
            winAmount: 0
        });
        recordLedgerEntry(profile, 'game_spend', -amount, profile.balance, `crash:${roundId}`);
        saveDatabase();
        io.to(`user:${profile.id}`).emit('balance_update', { balance: profile.balance });
        io.to(`user:${profile.id}`).emit('bet_accepted', { amount });
        broadcastRoundBets();
        console.log(`Stavka qabul qilindi: ${amount} ⭐`);
    };

    socket.on('place_bet', data => {
        acceptBet(Number(data && data.amount)).catch(error => {
            console.error('Crash stavkasi qabul qilinmadi:', error.message);
            socket.emit('bet_rejected', { error: 'Stavka vaqtincha qabul qilinmadi.' });
        });
    });

    socket.on('queue_bet', data => {
        const amount = Number(data && data.amount);
        if (gameState === 'waiting') {
            acceptBet(amount).catch(error => {
                console.error('Crash stavkasi qabul qilinmadi:', error.message);
                socket.emit('bet_rejected', { error: 'Stavka vaqtincha qabul qilinmadi.' });
            });
            return;
        }
        if (gameState !== 'running' && gameState !== 'crashed') {
            return socket.emit('bet_rejected', { error: 'Stavka navbatga qo‘yilmadi.' });
        }
        const existingBet = roundBets.get(profile.id);
        if ((existingBet && existingBet.status === 'active') || queuedBets.has(profile.id)) {
            return socket.emit('bet_rejected', { error: 'Bu raundda stavka qilgansiz yoki keyingi raund uchun navbatdasiz.' });
        }
        if (!Number.isSafeInteger(amount) || amount < 1) {
            return socket.emit('bet_rejected', { error: 'Stavka miqdori noto‘g‘ri.' });
        }
        if (profile.balance < amount) {
            return socket.emit('bet_rejected', { error: 'Balansda yetarli ⭐ yo‘q.' });
        }

        queuedBets.set(profile.id, { amount });
        io.to(`user:${profile.id}`).emit('bet_queued', { amount });
    });

    socket.on('cash_out', () => {
        const bet = roundBets.get(profile.id);
        if (gameState !== 'running' || !bet || bet.status !== 'active') {
            return socket.emit('cash_out_rejected', { error: 'Cash out qilib bo‘lmadi. Aloqani tekshirib, qayta urinib ko‘ring.' });
        }

        const cashOutMultiplier = Number(multiplier.toFixed(2));
        const winAmount = Math.floor(bet.amount * cashOutMultiplier);
        changeWalletBalance(profile, winAmount).then(balance => {
            if (balance === null) throw new Error('Crash yutug‘ini balansga yozib bo‘lmadi.');
            bet.status = 'cashed_out';
            bet.multiplier = cashOutMultiplier;
            bet.winAmount = winAmount;
            recordLedgerEntry(profile, 'crash_win', winAmount, profile.balance, `crash:${roundId}`);
            saveDatabase();
            io.to(`user:${profile.id}`).emit('balance_update', { balance: profile.balance });
            io.to(`user:${profile.id}`).emit('cash_out_success', { winAmount, multiplier: cashOutMultiplier });
            broadcastRoundBets();
        }).catch(error => {
            console.error('Crash cash out bajarilmadi:', error.message);
            socket.emit('cash_out_rejected', { error: 'Yutuqni balansga yozib bo‘lmadi. Qayta urinib ko‘ring.' });
        });
    });

    socket.on('pvp_place_bet', data => {
        placePvpBet(socket, profile, data).catch(error => {
            console.error('PvP stavkasi qabul qilinmadi:', error.message);
            socket.emit('pvp_bet_rejected', { error: 'Stavka vaqtincha qabul qilinmadi.' });
        });
    });

});

recoverInterruptedPvpRound().catch(error => {
    console.error('Uzilgan PvP raund tiklanmadi:', error.message);
});
processTournamentPayouts().catch(error => {
    console.error('Haftalik turnir mukofotlari hisoblanmadi:', error.message);
});
setInterval(() => {
    processTournamentPayouts().catch(error => {
        console.error('Haftalik turnir mukofotlari hisoblanmadi:', error.message);
    });
}, 60 * 1000);
startNewGame().catch(error => console.error('Crash raundi boshlanmadi:', error.message));

const PORT = process.env.PORT || 3000;
const listenOptions = localDevMode
    ? { port: PORT, host: '127.0.0.1' }
    : { port: PORT };
if (!process.env.VERCEL) {
    server.listen(listenOptions, () => {
        console.log(`Server ishga tushdi: http://localhost:${PORT}`);
        if (localDevMode) {
            console.log('Local demo rejim: Telegram bot tokeni kerak emas; virtual balans 10 000 Stars.');
            return;
        }

        setTelegramWebhook().then(() => {
            console.log('Telegram webhook sozlandi.');
        }).catch(error => {
            console.error('Telegram webhook sozlanmadi:', error.message);
        });
    });
}

module.exports = app;