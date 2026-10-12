# nusastakes/relayer

Relayer gas dan keeper APY untuk **Nusastakes** (game kota di Monad: setiap kota adalah vault ERC-4626).

> **Status: rencana, belum ada kode** (backlog B2.2 dan B2.9). Repo ini dipublikasikan lebih awal supaya riwayat
> commit hackathon terlihat; isinya akan diisi di fase 2.

## Tujuan

1. **Membayar gas deposit penduduk**, supaya penduduk tidak perlu memegang MON. Relayer tidak pernah memegang dana
   pengguna.
2. **Keeper APY**: menulis APY vault AUSD di mainnet ke kontrak `ApyFeed` di testnet, supaya yield simulasi
   (`MirrorYieldAdapter`) mengikuti pasar sungguhan.

## Rencana

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

Belum ada dependensi. Rencana: `viem`.

## Lisensi

MIT. Lihat `LICENSE`.
