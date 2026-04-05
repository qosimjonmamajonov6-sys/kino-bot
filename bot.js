const { Telegraf, Markup } = require('telegraf');
const fs = require('fs-extra');
const path = require('path');
const http = require('http');
const { Octokit } = require('@octokit/rest');
require('dotenv').config();

// Render.com uchun kichik HTTP server (bot uyquga ketmasligi uchun)
http.createServer((req, res) => {
    res.write('Bot is running!');
    res.end();
}).listen(process.env.PORT || 3000);

const bot = new Telegraf(process.env.BOT_TOKEN);
const MOVIES_PATH = path.join(__dirname, 'movies.json');
const USERS_PATH = path.join(__dirname, 'users.json');
const ENV_PATH = path.join(__dirname, '.env');

// GitHub Sozlamalari
const octokit = process.env.GITHUB_TOKEN ? new Octokit({ auth: process.env.GITHUB_TOKEN }) : null;
const GITHUB_CONFIG = {
    owner: process.env.GITHUB_OWNER || '',
    repo: process.env.GITHUB_REPO || '',
    branch: 'main'
};

// Ma'lumotlar
let movies = {};
let users = [];
let adminId = process.env.ADMIN_ID || null;
const channels = process.env.CHANNELS ? process.env.CHANNELS.split(',').map(c => c.trim()) : [];

// Admin holatini kuzatish uchun
const adminState = {};

async function loadData() {
    try {
        movies = await fs.readJson(MOVIES_PATH);
    } catch (err) {
        movies = {};
        await fs.writeJson(MOVIES_PATH, movies);
    }
    try {
        users = await fs.readJson(USERS_PATH);
    } catch (err) {
        users = [];
        await fs.writeJson(USERS_PATH, users);
    }
}

async function saveData() {
    await fs.writeJson(MOVIES_PATH, movies, { spaces: 2 });
    await fs.writeJson(USERS_PATH, users, { spaces: 2 });
}

async function updateAdmin(id) {
    adminId = id.toString();
    const currentToken = process.env.BOT_TOKEN;
    const currentChannels = process.env.CHANNELS || '';
    const envContent = `BOT_TOKEN=${currentToken}\nADMIN_ID=${adminId}\nCHANNELS=${currentChannels}\nGITHUB_TOKEN=${process.env.GITHUB_TOKEN || ''}\nGITHUB_OWNER=${process.env.GITHUB_OWNER || ''}\nGITHUB_REPO=${process.env.GITHUB_REPO || ''}\n`;
    await fs.writeFile(ENV_PATH, envContent);
}

// GitHub'ga yuklash funksiyasi
async function pushToGithub(ctx = null) {
    if (!octokit || !GITHUB_CONFIG.owner || !GITHUB_CONFIG.repo) {
        if (ctx) ctx.reply('⚠️ GitHub sozlamalari (.env faylda) to\'liq emas!');
        return;
    }
    try {
        const filesToPush = ['bot.js', 'movies.json', 'users.json', '.env', 'package.json'];
        for (const fileName of filesToPush) {
            const filePath = path.join(__dirname, fileName);
            if (!fs.existsSync(filePath)) continue;

            const content = await fs.readFile(filePath, 'utf8');
            const encodedContent = Buffer.from(content).toString('base64');

            let sha;
            try {
                const { data } = await octokit.repos.getContent({ ...GITHUB_CONFIG, path: fileName });
                sha = data.sha;
            } catch (e) {}

            await octokit.repos.createOrUpdateFileContents({
                ...GITHUB_CONFIG,
                path: fileName,
                message: `Auto-backup: ${new Date().toISOString()}`,
                content: encodedContent,
                sha: sha
            });
        }
        if (ctx) ctx.reply('✅ Ma\'lumotlar muvaffaqiyatli GitHub\'ga yuklandi!');
    } catch (error) {
        console.error('GitHub Error:', error);
        if (ctx) ctx.reply(`❌ GitHub xatoligi: ${error.message}`);
    }
}

// A'zolikni tekshirish
async function isSubscribed(ctx, userId) {
    if (adminId && userId.toString() === adminId) return true;
    for (const channel of channels) {
        try {
            const member = await ctx.telegram.getChatMember(channel, userId);
            const allowed = ['creator', 'administrator', 'member'];
            if (!allowed.includes(member.status)) return false;
        } catch (e) { return false; }
    }
    return true;
}

function getSubKeyboard() {
    const buttons = channels.map(channel => Markup.button.url('Kanalga a\'zo bo\'lish ➕', `https://t.me/${channel.replace('@', '')}`));
    buttons.push(Markup.button.callback('Tekshirish ✅', 'check_sub'));
    return Markup.inlineKeyboard(buttons, { columns: 1 });
}

loadData();

// Har bir yangi foydalanuvchini ro'yxatga olish
bot.use(async (ctx, next) => {
    if (ctx.from && !users.includes(ctx.from.id)) {
        users.push(ctx.from.id);
        await saveData();
    }
    return next();
});

bot.start(async (ctx) => {
    const userId = ctx.from.id;
    if (!adminId) {
        await updateAdmin(userId);
        return ctx.reply(`Tabriklaymiz! Siz ADMIN etib tayinlandingiz. \nSizning ID: ${userId}`);
    }
    const sub = await isSubscribed(ctx, userId);
    if (!sub) return ctx.reply('Botdan foydalanish uchun kanalimizga a\'zo bo\'ling:', getSubKeyboard());
    ctx.reply('Xush kelibsiz! Kino kodini yuboring. 🍿');
});

// Admin Keyboard
function getAdminKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('📊 Statistika', 'admin_stats'), Markup.button.callback('📢 Xabar yuborish', 'admin_broadcast')],
        [Markup.button.callback('📂 Zaxira (GitHub)', 'admin_backup'), Markup.button.callback('🗑 Kino o\'chirish', 'admin_delete')],
    ]);
}

// Admin Panel Command
bot.command('admin', (ctx) => {
    if (ctx.from.id.toString() !== adminId) return;
    ctx.reply('🛠 *Admin Paneli* \n\nQuyidagi amallardan birini tanlang:', {
        parse_mode: 'Markdown',
        ...getAdminKeyboard()
    });
});

// Admin Actions
bot.action('admin_stats', async (ctx) => {
    if (ctx.from.id.toString() !== adminId) return;
    const msg = `📊 *Statistika*\n\n🎬 Kinolar soni: ${Object.keys(movies).length} ta\n👥 Foydalanuvchilar: ${users.length} ta`;
    await ctx.answerCbQuery();
    await ctx.replyWithMarkdown(msg, getAdminKeyboard());
});

bot.action('admin_backup', async (ctx) => {
    if (ctx.from.id.toString() !== adminId) return;
    await ctx.answerCbQuery('Zaxiralash boshlandi...');
    await pushToGithub(ctx);
});

bot.action('admin_broadcast', async (ctx) => {
    if (ctx.from.id.toString() !== adminId) return;
    adminState[ctx.from.id] = { step: 'awaiting_broadcast' };
    await ctx.answerCbQuery();
    await ctx.reply('📢 Tarqatmoqchi bo\'lgan xabaringizni yuboring (Matn, Rasm, Video yoki Fayl bo\'lishi mumkin):', 
        Markup.inlineKeyboard([Markup.button.callback('❌ Bekor qilish', 'cancel_admin')])
    );
});

bot.action('admin_delete', async (ctx) => {
    if (ctx.from.id.toString() !== adminId) return;
    adminState[ctx.from.id] = { step: 'awaiting_delete_code' };
    await ctx.answerCbQuery();
    await ctx.reply('🗑 O\'chirmoqchi bo\'lgan kino kodini yuboring:', 
        Markup.inlineKeyboard([Markup.button.callback('❌ Bekor qilish', 'cancel_admin')])
    );
});

bot.action('cancel_admin', async (ctx) => {
    if (ctx.from.id.toString() !== adminId) return;
    delete adminState[ctx.from.id];
    await ctx.answerCbQuery('Bekor qilindi');
    await ctx.editMessageText('Amal bekor qilindi. 🛠 Admin Paneli:', getAdminKeyboard());
});

// Admin state-based message handler
bot.on('message', async (ctx, next) => {
    const userId = ctx.from.id;
    const state = adminState[userId];

    if (!state || userId.toString() !== adminId) return next();

    if (state.step === 'awaiting_broadcast') {
        delete adminState[userId];
        ctx.reply(`📢 Xabar ${users.length} ta foydalanuvchiga yuborilmoqda...`);
        let successCount = 0;
        for (const id of users) {
             try {
                await ctx.telegram.copyMessage(id, ctx.chat.id, ctx.message.message_id);
                successCount++;
             } catch (e) {
                console.error(`Failed to send to ${id}:`, e.message);
             }
        }
        return ctx.reply(`✅ Xabar muvaffaqiyatli tarqatildi! \nQabul qildi: ${successCount} ta foydalanuvchi.`);
    }

    if (state.step === 'awaiting_delete_code') {
        const code = ctx.message.text ? ctx.message.text.trim() : null;
        if (!code || !movies[code]) {
            return ctx.reply('❌ Bunday kodli kino topilmadi. Qayta yuboring yoki bekor qiling:');
        }
        
        adminState[userId] = { step: 'confirm_delete', code: code };
        return ctx.reply(`❓ Haqiqatan ham '${movies[code].name}' (kod: ${code}) kinosini o'chirib tashlamoqchimisiz?`,
            Markup.inlineKeyboard([
                [Markup.button.callback('✅ Ha, o\'chirilsin', `confirm_del_${code}`)],
                [Markup.button.callback('❌ Yo\'q, bekor qilish', 'cancel_admin')]
            ])
        );
    }

    return next();
});

// Deletion Confirmation Handler
bot.action(/^confirm_del_(.+)$/, async (ctx) => {
    if (ctx.from.id.toString() !== adminId) return;
    const code = ctx.match[1];
    if (movies[code]) {
        delete movies[code];
        await saveData();
        await ctx.answerCbQuery('Muvaffaqiyatli o\'chirildi');
        await ctx.editMessageText(`✅ Kod '${code}' muvaffaqiyatli o'chirildi.`, getAdminKeyboard());
        pushToGithub().catch(console.error);
    } else {
        await ctx.answerCbQuery('Xatolik: Kino topilmadi');
    }
    delete adminState[ctx.from.id];
});

// Tekshirish tugmasi
bot.action('check_sub', async (ctx) => {
    if (await isSubscribed(ctx, ctx.from.id)) {
        await ctx.answerCbQuery('Rahmat! ✅');
        await ctx.editMessageText('A\'zolik tasdiqlandi. Kino kodini yuboring:');
    } else {
        await ctx.answerCbQuery('Hali a\'zo bo\'lmadingiz! ❌', { show_alert: true });
    }
});

// Kino o'chirish
bot.command('del', async (ctx) => {
    if (ctx.from.id.toString() !== adminId) return;
    const code = ctx.message.text.split(' ')[1];
    if (code && movies[code]) {
        delete movies[code]; await saveData(); ctx.reply(`Kod '${code}' o'chirildi.`);
    }
});

// Kino qo'shish (Admin)
bot.on(['video', 'document'], async (ctx) => {
    if (!adminId || ctx.from.id.toString() !== adminId) return;
    const file = ctx.message.video || (ctx.message.document && ctx.message.document.mime_type.startsWith('video') ? ctx.message.document : null);
    if (!file) return;
    let cap = ctx.message.caption ? ctx.message.caption.trim() : null;
    let code = (cap && !isNaN(cap)) ? cap : (Object.keys(movies).length > 0 ? (Math.max(...Object.keys(movies).map(Number)) + 1).toString() : "100");
    movies[code] = { file_id: file.file_id, name: file.file_name || 'Video', date: new Date().toISOString() };
    await saveData();
    ctx.reply(`Saqlandi! ✅ Kod: ${code}`);
    pushToGithub().catch(console.error);
});

// Kino qidirish (User)
bot.on('text', async (ctx) => {
    const code = ctx.message.text.trim();
    if (isNaN(code)) return ctx.reply('Faqat kino kodini yuboring. 🔎');
    if (!(await isSubscribed(ctx, ctx.from.id))) return ctx.reply('Kanalga a\'zo bo\'ling:', getSubKeyboard());
    if (movies[code]) {
        await ctx.replyWithVideo(movies[code].file_id, { caption: `🎬 Kod: ${code}\n❤️ Yoqimli tomosha!` });
    } else { ctx.reply('Kechirasiz, bunday kodli kino topilmadi. ❌'); }
});

bot.launch().then(() => console.log('Kino Bot ishga tushdi! 🚀'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
