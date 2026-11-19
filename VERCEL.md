# Vercel’da Telegram Stars to‘lovlari

## Kerakli sozlamalar

1. Loyihani Vercel’ga import qiling va root directory sifatida `XS case` loyihasini tanlang.
2. Neon’da PostgreSQL database yarating va connection string’ni oling.
3. Vercel → **Settings → Environment Variables** bo‘limida quyidagilarni kiriting:

   | O‘zgaruvchi | Qiymati |
   | --- | --- |
   | `DATABASE_URL` | Neon connection string |
   | `BOT_TOKEN` | BotFather bergan bot tokeni |
   | `ADMIN_TOKEN` | Admin API uchun uzun, tasodifiy maxfiy qiymat |
   | `TELEGRAM_WEBHOOK_SECRET` | 32–256 ta harf/raqam, `_` yoki `-` dan iborat alohida tasodifiy qiymat |

   Maxfiy qiymatlarni chatga, kodga yoki Git’ga joylamang. Environment Variables o‘zgargach, loyihani qayta deploy qiling. `VERCEL_PROJECT_PRODUCTION_URL` Vercel tomonidan taqdim etiladi.

4. Deploy’dan so‘ng webhook’ni bir marta sozlang:

   ```text
   POST https://<production-domain>/api/setup-webhook
   x-admin-token: <ADMIN_TOKEN>
   ```

   Javobdagi `Telegram webhook sozlandi.` xabarini tekshiring. `DATABASE_URL`, `BOT_TOKEN` va `TELEGRAM_WEBHOOK_SECRET` mavjud bo‘lmasa, endpoint xato qaytaradi.
5. Mini App’ni Telegram ichidan ochib, test Stars to‘lovini bajaring. Telegram webhook to‘lovni tasdiqlagach balans avtomatik yangilanadi. Admin paneldagi **Stars va o‘yin jurnali** bo‘limi admin token bilan to‘lov va balans yozuvlarini ko‘rsatadi.

## Saqlash va qayta ishlash

Neon’dagi wallet jadvali balansni saqlaydi. Invoice webhookdan oldin Neon’da qayd etiladi; Telegram charge ID yagona kalit bo‘lgani uchun qayta yuborilgan webhook balansni ikkinchi marta oshirmaydi. To‘lov, xarid qilingan Stars soni, XTR miqdori, foydalanuvchi va vaqt Neon’da saqlanadi. Promokod/kanal mukofotlari bir martalik claim kaliti bilan, Slots so‘rovlari esa `requestId` bilan idempotent ishlanadi. Jadvallar birinchi server so‘rovida avtomatik yaratiladi.

`user-data.json` Vercel’da doimiy disk emas. Stars balansi va to‘lovlar Neon’da saqlanadi, ammo ilovaning qolgan JSON holati Vercel serverless instansiyalari orasida doimiy ulashilmaydi. Bundan tashqari, Vercel Functions doimiy Socket.IO ulanishlarini qo‘llamaydi; real vaqtli o‘yinlar uchun alohida persistent host kerak.
