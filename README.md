# nusastakes/relayer

Relayer gas dan keeper APY untuk **Nusastakes** (game kota di Monad: setiap kota adalah vault ERC-4626).

> **Status:** keduanya sudah ada dan diuji di Monad testnet. Relayer membayar gas setor dan tarik penduduk lewat
> `permit`; keeper menulis APY vault AUSD mainnet ke kontrak `ApyFeed`. Berjalan di Railway: https://relayer-production-39e1.up.railway.app (testnet).

## Relayer deposit (`src/server.mjs`)

Membayar gas setor dan tarik penduduk, sehingga penduduk tidak perlu memegang MON. Relayer tidak pernah memegang dana
pengguna: `depositWithPermit` mencetak share ke `owner`, dan `redeemWithPermit` membayar aset ke `owner` (penanda
tangan permit), siapa pun pengirimnya.

| Endpoint | Isi | Hasil |
| --- | --- | --- |
| `GET /health` | | alamat relayer, saldo MON, blok terakhir, dan `faucetEnabled`, `gasDripEnabled`, `styleEnabled` (supaya UI menyembunyikan tombol yang tidak aktif) |
| `POST /deposit` | `{ vault, owner, assets, deadline, v, r, s }` | `{ hash, status, shares, sharesOwner }` |
| `POST /withdraw` | `{ vault, owner, shares, deadline, v, r, s }` (permit atas **share** kota) | `{ hash, status, assets, receiver }`; aset selalu dibayar ke `owner` |
| `POST /faucet` | `{ address }` (hanya testnet) | `{ hash, status, recipient }`; `429` dengan `retryAfterSeconds` bila faucet baru dipakai |
| `POST /gas-drip` | `{ address }` (hanya testnet) | `{ hash, recipient, amountWei }`: 1 MON untuk walikota atau kunci sesinya (cukup untuk `createCity`, yang butuh saldo sekitar 0,63 MON), sekali per alamat per hari, hanya bila saldo < 0,7 MON |
| `POST /style` | `{ vault, code, nonce, signature }`; `signature` = EIP-712 `CityStyle(address vault, string code, uint256 nonce)` dari akun **walikota**, domain `{ name: "Nusastakes", version: "1", chainId: 10143 }` (tanpa `verifyingContract`) | `{ vault, code, nonce }`. `code` kosong atau `<tema>.<topeng base36>` (huruf kecil, angka, `-`, `_`; maksimal 32 karakter), `nonce` harus lebih besar dari yang tersimpan (nonce pertama boleh 0). `403` bila penanda tangan bukan `vault.mayor()`, `409` bila nonce basi |
| `GET /style/:vault` | | `{ code, nonce }` (`code: ""` bila belum ada) |

Perlindungan: vault harus dibuat oleh `CityFactory` (`isCity`), deadline permit minimal 20 detik ke depan, batas jumlah
(`MAX_DEPOSIT_ASSETS`, bawaan 10.000 AUSD), batas laju per pemilik (3 per menit) dan global (30 per menit), transaksi
disimulasikan dan diestimasi sebelum dikirim (permit rusak atau tanpa izin ditolak tanpa membuang gas), gas limit
eksplisit (estimasi × 125%, maksimum 1,5 juta karena Monad menagih gas limit, bukan yang terpakai), `maxFeePerGas` =
1,5 × base fee + tip (Monad menolak transaksi bila saldo < gas limit × `maxFeePerGas`, dengan galat samar
"Missing or invalid parameters"), antrean kirim satu per satu supaya nonce tidak bentrok, dan penolakan bila saldo
relayer tidak cukup. Pembatas laju per IP: setor dan tarik 30 per menit, faucet 5 per jam, gas-drip 3 per hari.

```
npm install
npm test                         # 65 tes unit (validasi, pembatas laju, antrean, logika dengan klien palsu, gaya kota)
RELAYER_PRIVATE_KEY=0x… npm start   # server di :8787; HTTP, dan keeper bila RUN_KEEPER=1 (src/main.mjs)
```

Variabel: `RELAYER_PRIVATE_KEY` (wajib, hanya dari environment), `MONAD_TESTNET_RPC`, `FACTORY_ADDRESS`, `AUSD_FAUCET`
(kosongkan untuk mematikan `/faucet`), `PORT`, `ALLOWED_ORIGIN` (CORS, beberapa origin dipisah koma, bawaan
`http://localhost:3000`), `MAX_DEPOSIT_ASSETS`, `TRUST_PROXY=1` (baca IP klien dari `X-Forwarded-For` di belakang
proxy), `RUN_KEEPER=1` (jalankan keeper APY dalam proses yang sama), `KEEPER_INTERVAL_SEC` (bawaan 3600), `STYLE_FILE` (berkas JSON
tempat gaya kota disimpan, bawaan `./data/styles.json`; isi dengan jalur di volume agar bertahan lintas deploy, kosongkan untuk
mematikan `/style`).

### Hosting di Railway

Terpasang di proyek `nusastakes-relayer`, layanan `relayer`, lingkungan `production`: **https://relayer-production-39e1.up.railway.app**. Satu layanan
(HTTP + keeper APY). `railway.json` menyiapkan perintah mulai (`npm start`), health check (`/health`), dan kebijakan
restart. Variabel di Railway: `RELAYER_PRIVATE_KEY` (rahasia, diisi lewat stdin, tidak ada di repo), `RUN_KEEPER=1`,
`TRUST_PROXY=1`, `NODE_ENV=production`, dan `ALLOWED_ORIGIN` (origin frontend dipisah koma; saat ini hanya
`http://localhost:3000`); `PORT` diisi Railway. Dompet relayer hanya memegang MON testnet dan perlu diisi ulang bila
habis (cek `GET /health`). Jalankan satu instance saja (batas laju di memori, satu pengirim nonce).

```
npx @railway/cli variable set ALLOWED_ORIGIN=https://app.example,http://localhost:3000 --service relayer
npx @railway/cli up --service relayer --detach      # deploy ulang dari folder relayer/
npx @railway/cli logs --service relayer
```

### Uji ujung ke ujung di testnet

`scripts/e2e-testnet.mjs` mengirim transaksi sungguhan: walikota mendirikan kota, penduduk baru **tanpa MON** meminta
AUSD lewat `/faucet`, menandatangani `permit` EIP-712 untuk AUSD ("Agora Dollar" versi "1"), relayer menyetor lewat
`/deposit`, walikota memindahkan setengah dana ke adapter yield simulasi, lalu penduduk menandatangani permit atas
share dan menarik semuanya lewat `/withdraw`. Penduduk tidak pernah memegang MON.

Untuk menguji relayer yang sudah di-host: `RELAYER_URL=https://relayer-production-39e1.up.railway.app node scripts/e2e-testnet.mjs`. Walikotanya
adalah dompet baru tanpa MON yang meminta `/gas-drip` lebih dulu.

Hasil 13 Okt 2026 pada deploy ke-2 (kota `0x451b92604f6C1A51adf95b7Ce53a25A9398Ba6c2`): saldo MON penduduk tetap 0 dari
awal sampai akhir, share (100 AUSD) tercetak ke penduduk, yield simulasi tumbuh (+1 satuan terkecil dalam 90 detik pada
50 AUSD dengan APY 1,28%), dan tarik penuh lewat relayer membayar 100 AUSD ke penduduk. Satu putaran menghabiskan
sekitar 0,5 MON dari dompet relayer (terutama `createCity`).

## Keeper APY (`src/keeper.mjs`)

Membaca APY vault AUSD di mainnet dan menulisnya ke `ApyFeed` di testnet, sehingga yield simulasi
`MirrorYieldAdapter` mengikuti pasar sungguhan.

- **Sumber utama:** kenaikan harga share vault Morpho "Grove x Steakhouse High Yield AUSD"
  (`0x32841A8511D5c2c5b253f45668780B99139e476D`, mainnet) antara dua blok dalam jendela 3 hari
  (`convertToAssets` pada blok sekarang dan blok 3 hari lalu), diannualkan sebagai bunga sederhana. Siapa pun bisa
  memeriksa angkanya sendiri di chain. Cadangan: field `netApy` dari API GraphQL Morpho bila RPC tidak bisa
  membaca state lama.
- **Penulisan:** `ApyFeed.setApy(sourceId, apyBps, observedAt)` dari kunci `RELAYER_PRIVATE_KEY`, yang harus menjadi
  `updater` di feed. Ditulis hanya bila berubah >= 5 bps atau bacaan terakhir lebih tua dari 6 jam.
- Contoh hasil (13 Okt 2026): 128 bps (1,28%); `apy` Morpho melaporkan 1,29% dan `netApy` 1,50% (memasukkan reward).

```
npm run keeper:dry                        # hitung dan cetak, tidak mengirim apa pun
RELAYER_PRIVATE_KEY=0x… npm run keeper    # tulis sekali
RELAYER_PRIVATE_KEY=0x… node src/keeper.mjs --loop --interval 3600
```

Variabel opsional: `MONAD_MAINNET_RPC`, `MONAD_TESTNET_RPC`, `APY_FEED_ADDRESS`, `APY_SOURCE_VAULT`, `APY_SOURCE_ID`.

## Belum diuji / batasan

- Akun Mera adalah EOA biasa menurut dokumentasi resmi dan `toViemAccount` mendukung `signTypedData`, tetapi permit
  belum ditandatangani dengan Mera sungguhan.
- Gaya kota (`/style`) hanya tampilan dan tidak memengaruhi dana. Isinya disimpan di berkas JSON milik server: tidak bisa
  diperiksa orang luar seperti event onchain, dan hilang bila deploy ulang tanpa volume. Tanda tangan walikota memastikan
  hanya walikota yang mengubah, tetapi operator relayer tetap bisa mengubah berkasnya. Tempat yang benar untuk jangka
  panjang adalah `CityVault.setStyle(bytes32)` di kontrak v3.
- Relayer belum diuji di bawah beban atau serangan sungguhan; pembatas laju hanya di memori satu proses.
- `/faucet` bergantung pada faucet publik Agora yang membatasi frekuensi sekitar satu tetes per 60 detik secara
  bersama; saat sibuk relayer mengembalikan `429`.

## Repo lain di organisasi

- [nusastakes/contracts](https://github.com/nusastakes/contracts): kontrak Solidity
- [nusastakes/web](https://github.com/nusastakes/web): antarmuka web dan kota 3D
- [nusastakes/cre-guardian](https://github.com/nusastakes/cre-guardian): workflow Chainlink CRE "City Guardian"

## Penggunaan alat AI

Dibuat dengan Claude Code (Claude Opus untuk rencana dan pemeriksaan, Claude Sonnet untuk pengerjaan). Keluaran AI
diperiksa pengembang; yang belum diuji ditulis "belum diuji". LLM tidak pernah memindahkan dana di luar aturan
deterministik kontrak.

## Komponen yang sudah ada sebelumnya

`viem` 2.57.4 (MIT). Faucet AUSD testnet milik Agora dan API GraphQL publik Morpho dipakai sebagai layanan luar.

## Lisensi

MIT. Lihat `LICENSE`.
