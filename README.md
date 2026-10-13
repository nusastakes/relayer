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
| `PUT /book` | `{ owner, id, ciphertext, nonce, signature }`; `signature` = EIP-712 `BookEntry(address owner, string id, bytes32 ciphertextHash, uint256 nonce)` dari akun **pemilik** (domain sama dengan `/style`), `ciphertext` hex maksimal 16 KB, `id` 1–64 karakter | `{ owner, id, hash, bytes, createdAt, nonce }` dengan `hash = keccak256(ciphertext)` (nilai yang dipakai klien sebagai `planHash` di `rebalance`). Penyimpanan **ciphertext saja** untuk buku strategi tersegel: entri tidak pernah ditimpa (`409`), `nonce` harus naik (nonce pertama boleh 0), maksimal 200 entri per pemilik, `403` bila bukan tanda tangan pemilik |
| `GET /book/:owner`, `GET /book/:owner/:id` | | daftar entri tanpa ciphertext beserta `nonce` terakhir (`"-1"` bila kosong), dan satu entri lengkap dengan ciphertext; publik, karena ciphertext tanpa kunci tidak berguna |
| `GET /agents` | | staf AI yang bisa dipekerjakan walikota (Satpam, Analis, Humas) dengan peran, alamat, status, dan identitas ERC-8004 (`erc8004`: `agentId`, pemilik, `agentURI`, rata-rata penilaian) |
| `GET /paid/report/:city?days=7` | header `PAYMENT-SIGNATURE` (x402) | laporan Humas yang sama dengan `/report`, tetapi berbayar: tanpa pembayaran menjawab 402 dengan syarat bayar; dengan pembayaran valid membangun laporan lalu menyelesaikan pembayaran (0,01 AUSD ke alamat Humas) dan mengembalikan laporan dengan header `PAYMENT-RESPONSE` |
| `GET /marketplace` | | bursa staf: agen tim dan agen komunitas yang lolos pemeriksaan, urut rata-rata penilaian ERC-8004; `?city=0x…` menambahkan `hiredInCity` per agen |
| `POST /marketplace/apply` | `{ "agentId": "…" }` | agen pihak ketiga mengajukan diri; server memeriksa identitas, dompet, dan berkas registrasinya sendiri (panduan: `AGENTS.md`) |
| `GET /agents/:id/card.json` | | berkas registrasi ERC-8004 agen (`satpam`, `analis`, `humas`), yang menjadi `agentURI` di registry |
| `GET /leaderboard` | | kota diurutkan menurut return sejak berdiri: `{ rank, name, community, mayor, tvl, returnBps, residents, createdAt, ranked }`. TVL dan return dibaca langsung dari rantai, jumlah penduduk dari pencatat. Kota dengan TVL di bawah 1 AUSD atau tanpa share tidak diberi peringkat (`rank: null`), karena harga share kota kosong tidak berarti |
| `GET /metrics`, `GET /index` | | angka platform untuk cerita traksi (kota, walikota, penduduk, TVL, jumlah setor dan tarik) dan kemajuan pencatat (`complete`, `behindBlocks`) |
| `GET /economy` | | laporan ekonomi (R13): fee per sektor Monad dari DefiLlama untuk 24 jam, 7 hari, dan 30 hari, lengkap dengan sumber, URL, dan waktu pengambilan; di-cache 10 menit, dan memakai data lama (`stale: true`) bila DefiLlama tidak terjangkau |
| `GET /report/:city?days=7` | | laporan Humas dalam bahasa Indonesia (1 sampai 30 hari) dari event on-chain dan snapshot harga; hanya untuk kota yang walikotanya memberi Humas (`0x8Df168681FE3EF206D8a3fE8eC0C003A776aD498`) peran `HUMAS` (3), jika tidak `status: not-hired` |
| `GET /analyst` | | `{ address, role: 2, roleName: "ANALIS", guardian, llm }`: alamat bot Analis (`0xDFef53a0d68fd0481c5d4b3D708F3Ed2e6313B1e`), yang harus diberi peran `ANALIS` oleh walikota |
| `GET /proposals/:city` | | usulan Analis untuk kota itu: `{ proposalId, planHash, txHash, status: pending / approved / expired, plan }` dengan `plan` memuat alasan dan angka; `keccak256(JSON.stringify(plan)) == planHash` |
| `POST /analyst/run` | `{ city }` | memeriksa satu kota sekarang; `{ status: proposed / nothing-to-do / not-granted / pending / cooldown / ... }`. Tidak berbahaya: dana baru bergerak bila walikota menyetujui |

Perlindungan: vault harus dibuat oleh `CityFactory` (`isCity`), deadline permit minimal 20 detik ke depan, batas jumlah
(`MAX_DEPOSIT_ASSETS`, bawaan 10.000 AUSD), batas laju per pemilik (3 per menit) dan global (30 per menit), transaksi
disimulasikan dan diestimasi sebelum dikirim (permit rusak atau tanpa izin ditolak tanpa membuang gas), gas limit
eksplisit (estimasi × 125%, maksimum 1,5 juta karena Monad menagih gas limit, bukan yang terpakai), `maxFeePerGas` =
1,5 × base fee + tip (Monad menolak transaksi bila saldo < gas limit × `maxFeePerGas`, dengan galat samar
"Missing or invalid parameters"), antrean kirim satu per satu supaya nonce tidak bentrok, dan penolakan bila saldo
relayer tidak cukup. Pembatas laju per IP: setor dan tarik 30 per menit, faucet 5 per jam, gas-drip 3 per hari.

```
npm install
npm test                         # 138 tes unit (validasi, pembatas laju, antrean, logika dengan klien palsu, gaya kota, Analis)
RELAYER_PRIVATE_KEY=0x… npm start   # server di :8787; HTTP, dan keeper bila RUN_KEEPER=1 (src/main.mjs)
```

Variabel: `RELAYER_PRIVATE_KEY` (wajib, hanya dari environment), `MONAD_TESTNET_RPC`, `FACTORY_ADDRESS`, `AUSD_FAUCET`
(kosongkan untuk mematikan `/faucet`), `PORT`, `ALLOWED_ORIGIN` (CORS, beberapa origin dipisah koma, bawaan
`http://localhost:3000`), `MAX_DEPOSIT_ASSETS`, `TRUST_PROXY=1` (baca IP klien dari `X-Forwarded-For` di belakang
proxy), `RUN_KEEPER=1` (jalankan keeper APY dalam proses yang sama), `KEEPER_INTERVAL_SEC` (bawaan 3600), `ANALYST_PRIVATE_KEY` (menyalakan bot Analis), `RUN_ANALYST=1` dan `ANALYST_INTERVAL_SEC` (bawaan 600) untuk memindai semua kota
tiap interval, `PROPOSALS_FILE` (bawaan `./data/proposals.json`), `BOOK_FILE` (bawaan `./data/book.json`, kosongkan untuk mematikan `/book`), `TRUST_PROXY_HOPS` (jumlah proxy tepercaya di depan relayer; **di Railway 2**, lihat bagian keamanan), `RUN_INDEXER=1` (menjalankan pencatat), `INDEX_FILE` (bawaan `./data/index.json`), `INDEX_RANGE` (blok per permintaan `getLogs`, bawaan 100), `INDEX_START_BLOCK` (bawaan blok deploy factory v2, 70461935), `INDEXER=0` / `ECONOMY=0` untuk mematikan, `HUMAS_ADDRESS` (menyalakan Humas), `ANTHROPIC_API_KEY` dan/atau `XKIRO_API_KEY` (opsional; Sonnet menulis alasan usulan, Anthropic dicoba lebih dulu lalu gateway xKiro
dengan model `anthropic/claude-sonnet-5` atau `XKIRO_MODEL`; `ANALYST_LLM=0` mengabaikannya), `STYLE_FILE` (berkas JSON
tempat gaya kota disimpan, bawaan `./data/styles.json`; isi dengan jalur di volume agar bertahan lintas deploy, kosongkan untuk
mematikan `/style`).

### Hosting di Railway

Terpasang di proyek `nusastakes-relayer`, layanan `relayer`, lingkungan `production`: **https://relayer-production-39e1.up.railway.app**. Satu layanan
(HTTP + keeper APY). `railway.json` menyiapkan perintah mulai (`npm start`), health check (`/health`), dan kebijakan
restart. Variabel di Railway: `RELAYER_PRIVATE_KEY` (rahasia, diisi lewat stdin, tidak ada di repo), `RUN_KEEPER=1`,
`TRUST_PROXY=1`, `NODE_ENV=production`, dan `ALLOWED_ORIGIN` (origin frontend dipisah koma; saat ini
`http://localhost:3000,http://localhost:3100`), dan `STYLE_FILE=/data/styles.json` di volume `relayer-volume` yang dipasang di `/data`
(`railway volume --service <ID layanan> add --mount-path /data`; nama layanan membuat CLI panic, pakai ID); `PORT` diisi Railway. Dompet relayer hanya memegang MON testnet dan perlu diisi ulang bila
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

Gaya kota di instance yang di-host: `VAULT=0x… DEPLOYER_PRIVATE_KEY=0x… RELAYER_URL=https://relayer-production-39e1.up.railway.app node scripts/style-check.mjs sakura.7` (kuncinya harus milik walikota kota itu). Pada 13 Okt 2026 uji ini lulus dan kodenya masih ada setelah redeploy.

Hasil 13 Okt 2026 pada deploy ke-2 (kota `0x451b92604f6C1A51adf95b7Ce53a25A9398Ba6c2`): saldo MON penduduk tetap 0 dari
awal sampai akhir, share (100 AUSD) tercetak ke penduduk, yield simulasi tumbuh (+1 satuan terkecil dalam 90 detik pada
50 AUSD dengan APY 1,28%), dan tarik penuh lewat relayer membayar 100 AUSD ke penduduk. Satu putaran menghabiskan
sekitar 0,5 MON dari dompet relayer (terutama `createCity`).

## Analis (`src/analyst.mjs`)

Anggota staf AI yang mengusulkan pemindahan dana (PRD R19); ia tidak pernah memindahkan dana sendiri. Walikota memberi alamat bot (`0xDFef53a0d68fd0481c5d4b3D708F3Ed2e6313B1e`, lihat `GET /analyst`) peran `ANALIS` lewat `CityGuardian.grantAgent(kota, bot, 2, masaBerlaku)`. Bot memindai kota-kota di mana ia berwenang; bila aturan menemukan sesuatu yang layak, ia memanggil `CityGuardian.propose(kota, dari, ke, jumlah, planHash)`. Dana baru bergerak ketika walikota memanggil `CityGuardian.approve(kota, id)`, yang menjalankan `rebalance` dalam batas `maxShiftBps` vault.

Aturan (`decide`, deterministik; angka tidak pernah datang dari LLM):
- Kas menganggur di atas batas aman (20% dari aset kota) dan sumber yield (APY dari `ApyFeed`, tidak lebih tua dari 7 hari) minimal 0,50%: usulkan memindahkan kelebihan kas ke adapter yield yang paling sedikit isinya, paling banyak 95% dari yang boleh dipindah vault dalam satu panggilan, dan minimal 1 AUSD.
- APY sumber di bawah 0,50% dan ada dana di adapter yield: usulkan menarik dana kembali ke kas.
- Data yield hilang atau basi, kota kosong, atau tidak ada adapter dengan yield yang dikenal: tidak ada usulan.
- Tidak mengusulkan lagi selama usulannya sendiri masih menunggu (belum disetujui dan belum lewat 1 hari), dan menunggu 30 menit setelah tiap usulan.

Alasan usulan ditulis dalam bahasa Indonesia dari fakta. Bila `ANTHROPIC_API_KEY` atau `XKIRO_API_KEY` diisi, Sonnet menulisnya (Anthropic dulu, xKiro bila gagal); teks LLM dibuang bila tidak menyebut jumlah yang diusulkan, dan alasan kembali ke template bila semua provider gagal. Jumlah dalam teks dipotong ke dua desimal, bukan dibulatkan. Alasan dan angkanya disimpan di relayer; `planHash` di rantai = `keccak256` dari JSON rencana (urutan kunci tetap), jadi alasan yang dibaca walikota dapat diperiksa terhadap usulan di rantai. Uji ujung ke ujung di testnet: `CITY=0x… node scripts/analyst-e2e.mjs`.

## Pencatat, papan peringkat, laporan ekonomi, dan Humas (`src/indexer.mjs`, `src/economy.mjs`, `src/humas.mjs`)

RPC publik Monad membatasi `eth_getLogs` ke 100 blok per permintaan, jadi pencatat berjalan di latar belakang dari blok deploy factory, per potongan, dan mengingat sampai mana ia membaca (berkas di volume). Yang disimpan: kota dan walikotanya (event `CityCreated`), pemegang share dari event `Transfer`, buku besar setoran, penarikan, pemindahan dana, evakuasi, fee, dan pembukaan kunci (dengan waktu blok), dan snapshot harga share serta total aset tiap jam. TVL dan return selalu dibaca langsung dari rantai. Backfill pertama (±40 ribu blok) memakan ±4,5 menit. Penduduk = pemegang share yang pernah setor (penerima fee walikota dan treasury tidak ikut kecuali mereka juga setor). Semua yang disimpan bisa dibangun ulang dari rantai.

Humas adalah anggota staf ketiga: hanya membaca dan menulis laporan, tanpa kunci dan tanpa transaksi. Angka laporan datang dari pencatat dan pembacaan langsung; teksnya disusun dari template atau ditulis ulang oleh LLM (Anthropic dulu, xKiro cadangan), dan tulisan LLM dibuang bila tidak memuat total aset dan persentase hasil. Alasan pemindahan diambil dari rencana Analis yang cocok dengan `planHash`; bila `planHash` itu hash entri buku strategi tersegel, laporan hanya menyebut bahwa alasannya tersegel. Bila riwayat harga baru dimulai setelah awal periode, laporan menyebut sejak kapan datanya ada.

## Buku strategi tersegel (`src/book.mjs`) dan daftar staf (`src/agents.mjs`)

PRD (arsitektur dan R10, bounty B17) menyebut "penyimpanan tak tepercaya" untuk ciphertext buku strategi. Browser mengenkripsi tiap entri dengan kunci turunan passkey (HKDF per entri), jadi relayer hanya memegang ciphertext yang tidak bisa ia baca. Perangkat kedua dengan passkey yang sama menurunkan kunci yang sama, mengambil ciphertext dari sini, dan mendekripsinya (cross-device test). Hash `keccak256(ciphertext)` dicatat on-chain sebagai `planHash` pada `rebalance`; di akhir musim walikota membuka kunci entri pilihan dan siapa pun bisa mengambil ciphertext publik, mendekripsi, dan mencocokkan hash. Entri tidak bisa ditimpa atau dihapus lewat API, supaya keputusan tidak bisa diganti diam-diam setelah hasilnya terlihat. Operator relayer tetap bisa menghapus berkasnya; yang membuktikan isi dan waktunya adalah hash on-chain. Skrip uji: `RELAYER_URL=https://relayer-production-39e1.up.railway.app node scripts/book-check.mjs`.

## Identitas dan reputasi staf (ERC-8004, `src/erc8004.mjs`, `scripts/erc8004.mjs`)

Ketiga staf terdaftar di Identity Registry ERC-8004 di **Monad testnet** (`0x8004A818BFB912233c491871b3d84c89A494BD9e`, v2.0.0) dengan berkas registrasi yang dilayani relayer ini: Satpam agen 2230 (pemilik dompet pemilik workflow CRE), Analis 2231, Humas 2232, masing-masing didaftarkan dari dompetnya sendiri (`deployments/erc8004-testnet.json` menyimpan id dan hash transaksi). Penilaian ditulis ke Reputation Registry (`0x8004B663056A597Dffe9eCcC1965A193B7388713`); registry menolak penilaian dari pemilik atau operator agen sendiri, jadi pemberi nilai harus dompet lain, dalam hal ini dompet walikota demo. Tiga penilaian awal berlabel `demo-seed` dan berasal dari dompet tim sendiri; itu memperlihatkan mekanismenya, bukan reputasi independen. `GET /agents` membaca rata-rata penilaian dari rantai (cache 30 detik; bila pembacaan gagal, daftar tetap tampil tanpa angka). Skrip: `node scripts/erc8004.mjs register | seed | feedback … | status`, hanya testnet. ABI diambil dari repo resmi karena implementasi registry belum terverifikasi di Sourcify. `ERC8004=0` mematikan fitur ini; `ERC8004_FILE` dan `PUBLIC_URL` mengganti berkas dan alamat publik.

## Bursa staf terbuka (`src/marketplace.mjs`, `AGENTS.md`, `scripts/community-agent.mjs`)

Selain tiga agen tim, bursa menampilkan agen pihak ketiga yang mendaftar di Identity Registry ERC-8004 (testnet), memasang berkas registrasi dengan bagian `nusastakes` (kemampuan `nusastakes.city-staff`, peran 2 atau 3, harga), lalu memanggil `POST /marketplace/apply`. Server memeriksa sendiri: agen ada, `getAgentWallet` terisi (inilah alamat yang diberi izin walikota), berkas termuat, `registrations` memuat agen itu di registry itu, kemampuan dan peran sah (peran 1 Satpam dicadangkan untuk workflow CRE). Berkas diambil hanya dari URI `data:application/json` atau `https://` ke host publik: bukan alamat IP, bukan port selain 443, tanpa kredensial, setiap jawaban DNS harus alamat publik dan koneksi dipaku ke alamat yang sudah diperiksa itu, tanpa pengalihan, batas 5 detik dan 32 KB. Teks dari berkas dibersihkan dan dibatasi, dan frontend tetap wajib meng-escape. Batas: 5 pengajuan per jam per IP, 30 per jam total, 50 agen komunitas. Daftar disimpan di `MARKETPLACE_FILE` (`/data/marketplace.json` di Railway); pemilik dan dompet dibaca ulang dari rantai tiap daftar ditampilkan, dan agen yang berubah ditandai `changed-since-application`. `MARKETPLACE=0` mematikan fitur. Skrip `community-agent.mjs run` menjalankan seluruh alur dengan agen contoh.

## Laporan berbayar dengan x402 (`src/x402.mjs`, `scripts/x402-pay.mjs`)

`GET /paid/report/:city` memakai protokol x402 v2 di Monad testnet (`eip155:10143`, skema `exact`). Pembeli menandatangani `transferWithAuthorization` (EIP-3009) AUSD sebesar harga (default `$0.01`, `X402_PRICE`), facilitator Monad (`https://x402-facilitator.molandak.org`) memverifikasi dan, setelah laporan jadi, menyelesaikan transfer ke alamat Humas serta membayar gasnya, jadi pembeli hanya butuh AUSD, tanpa MON. Aturannya: pembayaran baru diselesaikan setelah laporan benar-benar dibuat (kota tak dikenal atau Humas belum dipekerjakan tidak dikenai biaya, tanda tangan tidak pernah dikirim); bila penyelesaian gagal pembeli menerima 402 dan bukan laporan; permintaan berpembayaran dibatasi 20 per menit per alamat sebelum menyentuh facilitator; facilitator yang mati memberi 503 hanya di rute ini dan dicoba lagi pada permintaan berikutnya. Header CORS mengizinkan `payment-signature` dan membuka `payment-required` serta `payment-response`. **Klien harus mengizinkan AUSD secara eksplisit**: SDK x402 menolak token di luar daftar bawaannya kecuali `spendControls.allowedAssets` memuat `{ network: "eip155:10143", asset: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC", maxAmountPerPayment: "100000" }`. Bukti: `RELAYER_URL=… node scripts/x402-pay.mjs` (dompet sekali pakai, faucet, tanpa MON). Paket `@x402/core` dan `@x402/evm` 2.28.0 (dikelola Coinbase) dipasang dengan versi tetap; `@x402/fetch` hanya untuk skrip (devDependency). `X402=0` mematikan rute.

## Keamanan dan batas pemakaian

Relayer ini publik dan tanpa autentikasi, jadi ditinjau oleh agen independen (13 Okt 2026, laporan dan perbaikan di [DECISIONS](../docs/DECISIONS.md) dan vault TC49.14). Hal yang berlaku sekarang:
- **IP klien.** Di belakang proxy, hanya entri `X-Forwarded-For` yang ditambahkan proxy tepercaya yang dipakai (`TRUST_PROXY_HOPS` dari kanan); nilai yang bukan alamat IP diabaikan, IPv6 dikelompokkan per /64. **Diukur di Railway:** edge Railway menimpa header kiriman klien dan menulis `IP-klien, IP-edge`, jadi `TRUST_PROXY_HOPS=2` memberi IP klien asli (header palsu dibuang), sedangkan 1 akan menyamakan semua pengguna ke IP edge.
- **Pembatas laju** tumbuh paling banyak 50 ribu kunci (kunci baru ditolak bila penuh), semua rute berbagi 240 permintaan per menit per IP, dan GET publik yang membaca rantai (`/health`, `/leaderboard`, `/metrics`, `/proposals`) di-cache 5 sampai 10 detik dengan satu panggilan bersama.
- **Pengeluaran.** Gas drip berhenti bila relayer akan turun di bawah cadangan 2 MON dan dibatasi 40 per hari; gas yang dikomitmenkan untuk transaksi bersponsor dibatasi 5 MON per 24 jam dan antrean maksimal 10; faucet menghitung setiap percobaan (60 per jam per IP), termasuk yang ditolak cooldown. `GET /health` memuat `lowFunds`, `analystBalanceWei`, `queueDepth`, dan `gasSpentLast24hWei`.
- **Badan permintaan** harus `application/json` (415 bila bukan), supaya situs lain tidak bisa memakai jatah IP pengunjung lewat form.
- **Buku strategi** hanya bisa ditulis oleh walikota atau penyetor kota asli (cek lewat pencatat), tanda tangan diverifikasi sebelum jatah pemilik dipakai, dan ada batas byte (1 MB per pemilik, 20 MB total). Gaya kota juga memverifikasi tanda tangan sebelum jatah kota dipakai.
- **Analis** hanya bekerja untuk kota buatan factory (`isCity`), menolak vault dengan lebih dari 8 adapter, memindai satu kota satu kali pada satu waktu, dan paling banyak 100 usulan per hari.
- **Pencatat** menyiapkan semua timestamp sebelum mengubah state (kegagalan RPC tidak menggandakan hitungan), membagi dua rentang `getLogs` bila RPC menolak, dan membaca daftar kota per halaman.

Batas yang diketahui dan belum diperbaiki: keeper APY mengirim transaksi dari kunci yang sama tanpa antrean relayer (benturan nonce langka); pencatat membaca blok terbaru tanpa kedalaman konfirmasi atau rollback (risiko rendah di testnet); papan peringkat bisa dimainkan dengan donasi langsung ke vault dan jumlah penduduk bisa dipalsukan dengan banyak akun (sybil); nama dan komunitas kota adalah teks bebas dari penyerang, jadi **frontend harus meng-escape-nya** dan teks itu juga masuk ke prompt Humas (hanya memengaruhi laporan kota itu sendiri); dompet relayer dan Analis harus diisi ulang manual (`lowFunds` di `/health` memberi tanda).

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

- Pencatat: riwayat harga per jam baru ada sejak pencatat pertama berjalan (13 Okt 04:15 WIB), jadi laporan Humas untuk kota yang lebih tua hanya mencakup periode itu dan menyebutnya. Jumlah penduduk menghitung penyetor; share yang berpindah lewat transfer ke orang yang tidak pernah setor tidak terhitung. Bergantung pada RPC publik (100 blok per `getLogs`); bila RPC membatasi lebih ketat, pencatat tertinggal (`/index` menunjukkan `behindBlocks`).
- Analis: alasan dan rencana disimpan di berkas JSON relayer (hilang bila volume hilang), hanya hash-nya yang ada di rantai. Bot memakai satu kunci (`ANALYST_PRIVATE_KEY`) untuk semua kota, dan perannya berlaku per kota selama walikota tidak mencabutnya atau masa berlakunya habis. Aturannya sengaja sederhana (satu adapter yield simulasi); belum ada pembobotan risiko antar adapter.

- Akun Mera adalah EOA biasa menurut dokumentasi resmi dan `toViemAccount` mendukung `signTypedData`, tetapi permit
  belum ditandatangani dengan Mera sungguhan.
- Gaya kota (`/style`) hanya tampilan dan tidak memengaruhi dana. Isinya disimpan di berkas JSON milik server: tidak bisa
  diperiksa orang luar seperti event onchain, dan hilang bila deploy ulang tanpa volume (di Railway sudah dipasang volume di `/data`). Tanda tangan walikota memastikan
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
