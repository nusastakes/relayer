# nusastakes/relayer

Relayer gas dan keeper APY untuk **Nusastakes** (game kota di Monad: setiap kota adalah vault ERC-4626).

> **Status:** keduanya sudah ada dan diuji di Monad testnet. Relayer membayar gas deposit penduduk lewat `permit`;
> keeper menulis APY vault AUSD mainnet ke kontrak `ApyFeed`. Belum ada proses yang berjalan terus-menerus; keduanya
> dijalankan manual atau di server.

## Relayer deposit (`src/server.mjs`)

Membayar gas deposit penduduk, sehingga penduduk tidak perlu memegang MON. Relayer tidak pernah memegang dana
pengguna: `CityVault.depositWithPermit` mencetak share ke `owner` (penanda tangan permit), siapa pun pengirimnya.

| Endpoint | Isi | Hasil |
| --- | --- | --- |
| `GET /health` | | alamat relayer, saldo MON, blok terakhir |
| `POST /deposit` | `{ vault, owner, assets, deadline, v, r, s }` | `{ hash, status, shares, sharesOwner }` |
| `POST /faucet` | `{ address }` (hanya testnet) | `{ hash, status, recipient }`; `429` dengan `retryAfterSeconds` bila faucet baru dipakai |

Perlindungan: vault harus dibuat oleh `CityFactory` (`isCity`), deadline permit minimal 20 detik ke depan, batas jumlah
(`MAX_DEPOSIT_ASSETS`, bawaan 10.000 AUSD), batas laju per pemilik (3 per menit) dan global (30 per menit), transaksi
disimulasikan dan diestimasi sebelum dikirim (permit rusak atau tanpa izin ditolak tanpa membuang gas), gas limit
eksplisit (estimasi × 125%, maksimum 1,5 juta karena Monad menagih gas limit, bukan yang terpakai), antrean kirim
satu per satu supaya nonce tidak bentrok, dan penolakan bila saldo relayer di bawah 0,1 MON.

```
npm install
npm test                         # 37 tes unit (validasi, pembatas laju, antrean, logika dengan klien palsu)
RELAYER_PRIVATE_KEY=0x… npm start   # server di :8787
```

Variabel: `RELAYER_PRIVATE_KEY` (wajib, hanya dari environment), `MONAD_TESTNET_RPC`, `FACTORY_ADDRESS`, `AUSD_FAUCET`
(kosongkan untuk mematikan `/faucet`), `PORT`, `ALLOWED_ORIGIN` (CORS, bawaan `http://localhost:3000`),
`MAX_DEPOSIT_ASSETS`.

### Uji ujung ke ujung di testnet

`scripts/e2e-testnet.mjs` mengirim transaksi sungguhan: walikota mendirikan kota, penduduk baru **tanpa MON** meminta
AUSD lewat `/faucet`, menandatangani `permit` EIP-712 untuk AUSD ("Agora Dollar" versi "1"), relayer menyetor lewat
`/deposit`, walikota memindahkan setengah dana ke adapter yield simulasi, lalu penduduk menarik semuanya.

Hasil 13 Okt 2026 (kota `0x3f4ACb2Be354eBE00A1014F789770187fD7dd5cb`): saldo MON penduduk tetap 0 setelah setor, share
(100 AUSD) tercetak ke penduduk, yield simulasi tumbuh (+1 satuan terkecil dalam 90 detik pada 50 AUSD dengan APY
1,28%), dan tarik penuh mengembalikan 100,000001 AUSD. Dompet yang baru diisi butuh beberapa detik sebelum transaksi
pertamanya diterima.

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

- Penarikan tanpa MON: `CityVault` tidak punya `permit` untuk share, jadi penduduk tetap butuh gas (atau akun Mera yang
  disponsori) untuk menarik. Di uji ujung ke ujung, penduduk diberi sedikit MON dulu.
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
