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
        const rawMovies = await fs.readJson(MOVIES_PATH);
        movies = {};
        // Ma'lumotlarni yangi formatga o'tkazish (Migration)
        for (const code in rawMovies) {
            const data = rawMovies[code];
            if (data.episodes) {
                movies[code] = data;
            } else {
                movies[code] = {
                    name: data.file_name || 'Video',
                    episodes: [{
                        file_id: data.file_id,
                        file_name: data.file_name || 'Video',
                        date: data.date || new Date().toISOString()
                    }]
                };
            }
        }
        console.log('Kinolar muvaffaqiyatli yuklandi! 🎬');
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

// loadData(); // O'chirildi, oxirida chaqirilmoqda

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
    const payload = ctx.startPayload; // Maxsus havola orqali kelgan kino kodi

    if (!adminId) {
        await updateAdmin(userId);
        return ctx.reply(`Tabriklaymiz! Siz ADMIN etib tayinlandingiz. \nSizning ID: ${userId}`);
    }

    const sub = await isSubscribed(ctx, userId);
    if (!sub) return ctx.reply('Botdan foydalanish uchun kanalimizga a\'zo bo\'ling:', getSubKeyboard());

    // Agar havola orqali kino kodi kelgan bo'lsa
    if (payload && movies[payload]) {
        const movie = movies[payload];
        const firstEpisode = movie.episodes[0];
        const keyboard = getEpisodeKeyboard(payload, 0);
        return ctx.replyWithVideo(firstEpisode.file_id, { 
            caption: `🎬 Kod: ${payload}${movie.episodes.length > 1 ? `\n🍿 1 - qism` : ''}\n❤️ Yoqimli tomosha!`,
            ...(keyboard ? keyboard : {})
        });
    }

    ctx.reply('Xush kelibsiz! Kino kodini yuboring. 🍿');
});

// Admin Keyboard
function getAdminKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('📊 Statistika', 'admin_stats'), Markup.button.callback('📢 Xabar yuborish', 'admin_broadcast')],
        [Markup.button.callback('📂 Zaxira (GitHub)', 'admin_backup'), Markup.button.callback('🗑 Kino o\'chirish', 'admin_delete')],
        [Markup.button.callback('📢 Kanalga ulashish', 'admin_share_channel')],
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

bot.action('admin_share_channel', async (ctx) => {
    if (ctx.from.id.toString() !== adminId) return;
    adminState[ctx.from.id] = { step: 'awaiting_share_code' };
    await ctx.answerCbQuery();
    await ctx.reply('📢 Kanalga reklama sifatida chiqarmoqchi bo\'lgan kino kodini yuboring:', 
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

    if (state.step === 'awaiting_share_code') {
        const code = ctx.message.text ? ctx.message.text.trim() : null;
        if (!code || !movies[code]) {
            return ctx.reply('❌ Bunday kodli kino topilmadi. Qayta yuboring yoki bekor qiling:', 
                Markup.inlineKeyboard([Markup.button.callback('❌ Bekor qilish', 'cancel_admin')])
            );
        }
        
        adminState[userId] = { step: 'awaiting_share_image', code: code };
        return ctx.reply(`📸 Endi '${movies[code].name}' uchun kanalga chiqadigan **rasmni (poster)** yuboring:`,
            Markup.inlineKeyboard([Markup.button.callback('❌ Bekor qilish', 'cancel_admin')])
        );
    }

    if (state.step === 'awaiting_share_image') {
        const photo = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1].file_id : null;
        if (!photo) {
            return ctx.reply('❌ Iltimos, reklama uchun rasm yuboring:', 
                Markup.inlineKeyboard([Markup.button.callback('❌ Bekor qilish', 'cancel_admin')])
            );
        }

        const code = state.code;
        delete adminState[userId];
        await shareToChannel(code, photo, ctx);
        return;
    }

    // Agar step noaniq bo'lsa, keyingi handlerga o'tish
    return next();
});

// Kanalga share qilish funksiyasi
async function shareToChannel(code, photoFileId, ctx) {
    const movie = movies[code];
    const channelId = channels[0]; // Reklama @ANIMELAR_1312 kanaliga ketadi
    console.log(`Kanalga rasm bilan post yuborish: Kod=${code}, Kanal=${channelId}`);

    if (!channelId) return ctx.reply('❌ Kanal sozlanmagan! (.env faylda CHANNELS qismini tekshiring)');

    const botUsername = ctx.botInfo.username;
    const watchLink = `https://t.me/${botUsername}?start=${code}`;

    const caption = `🎬 *${movie.name}*\n\n🔥 Yangi seryal/kino botga qo'shildi!\n🔎 Kod: \`${code}\` \n\n🍿 Marhamat, pastdagi tugmani bosib tomosha qiling:`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.url('Tomosha qilish 🍿', watchLink)]
    ]);

    try {
        await ctx.telegram.sendPhoto(channelId, photoFileId, {
            caption: caption,
            parse_mode: 'Markdown',
            ...keyboard
        });
        ctx.reply('✅ Kanalga reklama rasm bilan muvaffaqiyatli yuborildi!');
    } catch (error) {
        console.error('Kanalga rasm yuborishda xatolik:', error);
        ctx.reply(`❌ Kanalga yuborishda xatolik yuz berdi: ${error.message}\n\nEslatma: Bot kanalizda admin ekanligini tekshiring.`);
    }
}

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
    let code = (cap && !isNaN(cap)) ? cap : null;

    if (!code) {
        // Agar caption bo'lmasa yoki son bo'lmasa, yangi kod yaratamiz
        code = (Object.keys(movies).length > 0 ? (Math.max(...Object.keys(movies).map(Number)) + 1).toString() : "100");
    }

    const newEpisode = { 
        file_id: file.file_id, 
        file_name: file.file_name || 'Video', 
        date: new Date().toISOString() 
    };

    if (movies[code]) {
        movies[code].episodes.push(newEpisode);
        ctx.reply(`Mavjud ${code}-kodga yangi qism qo'shildi! ✅ \nJami qismlar: ${movies[code].episodes.length}`);
    } else {
        movies[code] = { 
            name: file.file_name || 'Video', 
            episodes: [newEpisode] 
        };
        ctx.reply(`Yangi kino saqlandi! ✅ Kod: ${code}`);
    }

    await saveData();
    pushToGithub().catch(console.error);
});

// Qismlar uchun klaviatura yaratish
function getEpisodeKeyboard(code, currentEp) {
    const movie = movies[code];
    if (!movie || movie.episodes.length <= 1) return null;

    const buttons = [];
    let row = [];
    movie.episodes.forEach((_, index) => {
        const label = (index === currentEp) ? `· ${index + 1} ·` : `${index + 1}`;
        row.push(Markup.button.callback(label, `ep_${code}_${index}`));
        if (row.length === 5) {
            buttons.push(row);
            row = [];
        }
    });
    if (row.length > 0) buttons.push(row);
    return Markup.inlineKeyboard(buttons);
}

// Qismni alohida xabar qilib yuborish
bot.action(/^ep_(.+)_(.+)$/, async (ctx) => {
    const code = ctx.match[1];
    const epIndex = parseInt(ctx.match[2]);
    
    if (!movies[code] || !movies[code].episodes[epIndex]) {
        return ctx.answerCbQuery('Qism topilmadi! ❌');
    }

    const movie = movies[code];
    const episode = movie.episodes[epIndex];
    const keyboard = getEpisodeKeyboard(code, epIndex);

    try {
        await ctx.answerCbQuery(`${epIndex + 1}-qism yuborilmoqda...`);
        await ctx.replyWithVideo(episode.file_id, {
            caption: `🎬 Kod: ${code}\n🍿 Qism: ${epIndex + 1}\n❤️ Yoqimli tomosha!`,
            ...(keyboard ? keyboard : {})
        });
    } catch (e) {
        console.error('Episode send error:', e);
        await ctx.reply('❌ Videoni yuborishda xatolik yuz berdi.');
    }
});

// Kino qidirish (User)
bot.on('text', async (ctx) => {
    const code = ctx.message.text.trim();
    if (isNaN(code)) return ctx.reply('Faqat kino kodini yuboring. 🔎');
    
    if (!(await isSubscribed(ctx, ctx.from.id))) {
        return ctx.reply('Botdan foydalanish uchun kanalimizga a\'zo bo\'ling:', getSubKeyboard());
    }

    if (movies[code]) {
        const movie = movies[code];
        const firstEpisode = movie.episodes[0];
        const keyboard = getEpisodeKeyboard(code, 0);

        await ctx.replyWithVideo(firstEpisode.file_id, { 
            caption: `🎬 Kod: ${code}${movie.episodes.length > 1 ? `\n🍿 1 - qism` : ''}\n❤️ Yoqimli tomosha!`,
            ...(keyboard ? keyboard : {})
        });
    } else { 
        ctx.reply('Kechirasiz, bunday kodli kino topilmadi. ❌'); 
    }
});

// Xatoliklarni ushlash (Bot to'xtab qolmasligi uchun)
bot.catch((err, ctx) => {
    console.error(`Xatolik yuz berdi (${ctx.updateType}):`, err);
});

// Botni ishga tushirish funksiyasi (xatolik bo'lsa qayta urinadi)
async function startBot() {
    try {
        await loadData();
        await bot.launch();
        console.log('Kino Bot ishga tushdi! 🚀');
    } catch (err) {
        console.error('Botni ishga tushirishda xatolik yuz berdi:', err.message);
        console.log('5 soniyadan keyin qayta urunib ko\'riladi...');
        setTimeout(startBot, 5000);
    }
}

startBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
