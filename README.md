# nusastakes/relayer

Relayer gas dan keeper APY untuk **Nusastakes** (game kota di Monad: setiap kota adalah vault ERC-4626).

> **Status:** keeper APY (B2.9) sudah ada dan berjalan di Monad testnet. Relayer gas untuk deposit (B2.2) masih
> rencana.

## Tujuan

1. **Membayar gas deposit penduduk**, supaya penduduk tidak perlu memegang MON. Relayer tidak pernah memegang dana
   pengguna.
2. **Keeper APY**: menulis APY vault AUSD di mainnet ke kontrak `ApyFeed` di testnet, supaya yield simulasi
   (`MirrorYieldAdapter`) mengikuti pasar sungguhan.

## Keeper APY (sudah ada)

`src/keeper.mjs` membaca APY vault AUSD di mainnet dan menulisnya ke `ApyFeed` di testnet, sehingga yield simulasi
`MirrorYieldAdapter` mengikuti pasar sungguhan.

- **Sumber utama:** kenaikan harga share vault Morpho "Grove x Steakhouse High Yield AUSD"
  (`0x32841A8511D5c2c5b253f45668780B99139e476D`, mainnet) antara dua blok dalam jendela 3 hari
  (`convertToAssets` pada blok sekarang dan blok 3 hari lalu), diannualkan sebagai bunga sederhana. Siapa pun bisa
  memeriksa angkanya sendiri di chain. Cadangan: field `netApy` dari API GraphQL Morpho bila RPC tidak bisa
  membaca state lama.
- **Penulisan:** `ApyFeed.setApy(sourceId, apyBps, observedAt)` dari kunci `RELAYER_PRIVATE_KEY`, yang harus menjadi
  `updater` di feed. Ditulis hanya bila berubah >= 5 bps atau bacaan terakhir lebih tua dari 6 jam.
- Contoh hasil (13 Okt 2026): 128 bps (1,28%) dari harga share 1,026067… ke 1,026175… dalam 259.200 detik; `apy`
  Morpho melaporkan 1,29% dan `netApy` 1,50% (memasukkan reward).

```
npm install
npm test                                  # tes hitung APY dan pencarian blok
npm run keeper:dry                        # hitung dan cetak, tidak mengirim apa pun
RELAYER_PRIVATE_KEY=0x… npm run keeper    # tulis sekali
RELAYER_PRIVATE_KEY=0x… node src/keeper.mjs --loop --interval 3600
```

Variabel opsional: `MONAD_MAINNET_RPC`, `MONAD_TESTNET_RPC`, `APY_FEED_ADDRESS`, `APY_SOURCE_VAULT`, `APY_SOURCE_ID`.
Kunci tidak pernah ditulis ke file yang dilacak git. Belum ada layanan yang menjalankan `--loop` terus-menerus; itu
perlu dijalankan di mesin atau server.

## Rencana relayer deposit

- Layanan Node kecil dengan `viem`.
- Menerima `permit` yang sudah ditandatangani penduduk (`owner`, `assets`, `deadline`, `v`, `r`, `s`), lalu memanggil
  `CityVault.depositWithPermit(owner, assets, deadline, v, r, s)` di Monad testnet. Kontrak mencetak share ke `owner`
  (penanda tangan), bukan ke relayer.
- Kunci relayer hanya di environment variable `RELAYER_PRIVATE_KEY`. Jangan pernah ditulis ke file yang dilacak git.
- Monad menagih gas limit, bukan gas terpakai: set gas limit secara eksplisit dan jangan berlebihan. Wallet yang baru
  diisi butuh beberapa detik sebelum bisa mengirim transaksi.
- Batasi laju per alamat dan hanya terima panggilan ke vault yang dibuat oleh `CityFactory`.
- Keeper APY: prioritas menghitung APY dari perubahan `convertToAssets(1e18)` vault Morpho mainnet antara dua titik
  waktu (bisa diverifikasi onchain); cadangan: field `netApy` dari API GraphQL Morpho.

## Belum diuji

`permit` AUSD testnet dengan tanda tangan valid dan transfer tanpa gas belum pernah diuji siapa pun.

## Repo lain di organisasi

- [nusastakes/contracts](https://github.com/nusastakes/contracts): kontrak Solidity
- [nusastakes/web](https://github.com/nusastakes/web): antarmuka web dan kota 3D
- [nusastakes/cre-guardian](https://github.com/nusastakes/cre-guardian): workflow Chainlink CRE "City Guardian"

## Penggunaan alat AI

Dibuat dengan Claude Code (Claude Opus untuk rencana dan pemeriksaan, Claude Sonnet untuk pengerjaan). Keluaran AI
diperiksa pengembang; yang belum diuji ditulis "belum diuji". LLM tidak pernah memindahkan dana di luar aturan
deterministik kontrak.

## Komponen yang sudah ada sebelumnya

`viem` 2.57.4 (MIT).

## Lisensi

MIT. Lihat `LICENSE`.
