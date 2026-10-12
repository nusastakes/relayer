# relayer

Status: rencana. Belum ada kode (backlog B2.2, Fase 2).

## Tujuan

Membayar gas untuk deposit penduduk, sehingga penduduk tidak perlu memegang MON. Relayer tidak pernah memegang dana pengguna.

## Rencana

- Layanan Node kecil dengan `viem`.
- Menerima `permit` yang sudah ditandatangani penduduk (`owner`, `assets`, `deadline`, `v`, `r`, `s`), lalu memanggil `CityVault.depositWithPermit` di Monad testnet.
- Kontrak mencetak share ke `owner` (penanda tangan), bukan ke relayer, jadi relayer tidak bisa mencuri share.
- Kunci relayer hanya di environment variable `RELAYER_PRIVATE_KEY` (lihat `../.env.example`). Jangan pernah ditulis ke file yang dilacak git.
- Monad menagih gas limit, bukan gas terpakai: set gas limit secara eksplisit dan jangan berlebihan.
- Wallet yang baru diisi butuh beberapa detik sebelum bisa mengirim transaksi.
- Batasi laju per alamat dan hanya terima panggilan ke vault yang dibuat oleh `CityFactory`.

## Belum diuji

`permit` AUSD testnet dan transfer tanpa gas belum pernah diuji siapa pun (lihat PRD, bagian Aset dasar).
