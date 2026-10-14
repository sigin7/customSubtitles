# Custom Subtitles

Osobný Stremio addon a webové rozhranie na nahrávanie titulkov. Jeden proces spustí server a otvorí stránku. Titulky zostávajú na tvojom počítači; z ďalších zariadení sa pripájaš cez Tailscale.

## Spustenie

Potrebuješ **Node.js 24 alebo novší**: [nodejs.org](https://nodejs.org/). Nie sú potrebné žiadne npm balíky ani API kľúč.

Vo Windows otvor `start.cmd`, alebo v termináli VS Code spusti:

```powershell
node --env-file-if-exists=.env src/launcher.js
```

Ak máš npm, funguje aj `npm start`. Vo VS Code môžeš stlačiť **F5** a vybrať `Custom Subtitles: server + web`. Ak vo Windows nemáš systémový Node.js, `start.cmd` skúsi aj existujúci Node runtime aplikácie Codex. Preň je pripravená druhá F5 konfigurácia `Custom Subtitles: Windows Codex Node runtime`. Na ostatných počítačoch nainštaluj štandardný Node.js 24 LTS.

Rozhranie sa otvorí na **http://127.0.0.1:7000**. Terminál nechaj otvorený. `Ctrl+C` zastaví server. Na serveri bez obrazovky nastav `OPEN_BROWSER=false` v `.env`, alebo spusti `node --env-file-if-exists=.env src/server.js`.

## Nahratie a párovanie

1. Vyber **film** alebo **seriál** a vyhľadaj názov či IMDb ID. Vyber správny výsledok. Vyhľadávanie používa Cinemeta, predvolený zdroj metadát Stremio; potrebuje internet. Názov a IMDb ID môžeš zadať aj ručne bez internetu.
2. Pri seriáli vyber sériu a epizódu. Séria 0 je povolená pre špeciály.
3. Vyber alebo presuň **jeden súbor** `.srt`, `.vtt`, `.ass` alebo `.ssa` do 10 MB. Nastav jazyk a prípadne označenie verzie, napr. `1080p BluRay`.
4. Klikni **Nahrať do knižnice**. Rovnaký obsah, video, jazyk a označenie sa nevložia druhýkrát.

Film sa páruje podľa IMDb ID, napr. `tt1375666`. Seriál sa páruje podľa ID celého seriálu, série a epizódy, napr. `tt0903747:1:2`. Názov slúži na zobrazenie v knižnici. Názov súboru môže predvyplniť `S01E02`, `1x02`, IMDb ID a SK/CZ/EN jazyk; tieto údaje pred nahratím skontroluj. Samotný názov súboru neurčuje spoľahlivo film.

Addon poskytuje titulky pre videá s IMDb ID. Videá identifikované iba pomocou `tmdb:` alebo vlastných ID iného addonu sa nepárujú. Viac verzií k jednému videu je možné; správne časovanie vzhľadom na konkrétny stream musíš vybrať ty. Titulky sa automaticky neposúvajú ani nesynchronizujú.

Text sa pri nahratí prevedie do UTF-8. Automatická detekcia podporuje UTF-8, UTF-16 s BOM a pri neplatnom UTF-8 skúsi Windows-1250 pre slovenské a české titulky. Ak text nesedí, vyber kódovanie ručne. ASS/SSA zachovajú pôvodné štýly; ich vykreslenie závisí od prehrávača a jeho nastavení.

## Tailscale a Stremio na ďalších zariadeniach

1. Nainštaluj [Tailscale](https://tailscale.com/download) na server aj klientské zariadenia a prihlás ich do rovnakej siete.
2. Nechaj túto aplikáciu spustenú a v samostatnom termináli na serveri spusti:

```powershell
tailscale serve --bg http://127.0.0.1:7000
```

3. Ak Tailscale vyžiada zapnutie HTTPS, dokonči jeho pokyny. Príkaz vypíše adresu ako `https://moj-pc.moja-siet.ts.net`.
4. V lokálnom webovom rozhraní otvor **Pripojenie**, vlož vypísanú HTTPS adresu a ulož ju. Alternatívne nastav `BASE_URL` v `.env` pred spustením.
5. Skopíruj z rozhrania **celú adresu manifestu**. Obsahuje trvalý prístupový kľúč: `https://…/addon/<kluc>/manifest.json`. V Stremio otvor **Addons** a vlož adresu, alebo použi **Otvoriť v Stremio**.
6. Na ďalšom zariadení nechaj Tailscale pripojený. Web otvoríš na rovnakej HTTPS adrese; pri danom filme/epizóde sa titulky objavia v ponuke prehrávača.

`Tailscale Serve` sprístupňuje server v tvojej Tailscale sieti cez HTTPS. Pri prvom prístupe musí byť adresa už nastavená lokálne, inak server odmietne neznámy Host. HTTPS je vhodné aj pre Stremio Web, kde môže byť vzdialené HTTP blokované. Dostupnosť Tailscale a vlastných addonov over na svojom konkrétnom TV alebo mobilnom klientovi. Server musí byť zapnutý a nesmie spať. Synchronizácia addonu v Stremio účte sama osebe nenahrádza Tailscale pripojenie.

Pri zmene adresy servera odinštaluj addon so starou adresou a nainštaluj aktuálnu adresu. Už otvorené prehrávanie môže mať titulky v pamäti; po uploadovaní znova otvor výber titulkov alebo prehrávanie.

## Nastavenia a súkromie

Skopíruj `.env.example` do `.env`, ak chceš zmeniť nastavenia:

| Premenná | Predvolená hodnota | Význam |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Lokálne počúvanie vhodné pre Tailscale Serve. |
| `PORT` | `7000` | Port servera; pri zmene uprav aj Tailscale Serve. |
| `BASE_URL` | adresa uložená v rozhraní alebo lokálna adresa | Adresa na inštaláciu addonu a sťahovanie titulkov. Nastavenie v `.env` má prednosť. |
| `ADMIN_PASSWORD` | bez hesla | Voliteľné heslo správcu, aspoň 12 znakov. |
| `OPEN_BROWSER` | `true` | Hodnota `false` vypne automatické otvorenie prehliadača. |
| `DATA_DIR` | `./data` | Priečinok databázy, relatívny ku koreňu projektu. |

Bez hesla môže knižnicu spravovať každý, kto sa dostane k rozhraniu cez tvoju Tailscale sieť. Prístup môžeš obmedziť pravidlami Tailscale a heslom `ADMIN_PASSWORD`. Pri nastavenom hesle sa na stránke zobrazí prihlasovanie; Stremio používa prístupový kľúč v URL a heslo správcu nepotrebuje. Kľúč neposielaj do verejných diskusií a screenshotov.

Titulky a kľúč sú uložené v `data/library.sqlite`, nastavenia môžu vytvoriť aj WAL súbory. **Zálohuj celý priečinok `data/` po zastavení servera.** Súbory `.env`, databáza a nahrané titulky sú v `.gitignore`. Ak nastavíš vlastný `DATA_DIR` vnútri projektu, pridaj jeho cestu do `.gitignore`. Pre tú istú databázu používaj jednu inštanciu servera. Táto aplikácia neposkytuje video streamy.

## Vývoj a testovanie

```powershell
node --test
node --watch --env-file-if-exists=.env src/server.js
```

S npm sú k dispozícii `npm test`, `npm run check` a `npm run dev`. Integračné testy overujú reálne HTTP nahrávanie a sťahovanie, Stremio manifest a dodatočné parametre, izoláciu epizód, neplatné súbory, veľkosť, duplikáty, pôvod požiadaviek, heslo, mazanie a obnovenie databázy. Vyhľadávanie metadát je v testoch nahradené kontrolovanou odpoveďou. GitHub Actions spúšťa testy na Windows aj Linuxe.

```text
src/server.js      HTTP server, API, Stremio protokol, prihlásenie
src/library.js     SQLite databáza a trvalý kľúč addonu
src/subtitles.js   Overenie metadát, kódovanie a názvy súborov
src/launcher.js    Spustenie servera a prehliadača
public/           Slovenské webové rozhranie
test/             Integračné testy
```

## Git

Zdrojový projekt je určený pre [sigin7/customSubtitles](https://github.com/sigin7/customSubtitles). Po úpravách:

```powershell
git status
git add .
git commit -m "Update custom subtitles addon"
git push origin main
```

Nahrané titulky, databázu ani `.env` nepridávaj cez `git add -f`.

Protokol vychádza z [dokumentácie Stremio subtitles](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/subtitles.md) a [Stremio manifestu](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/manifest.md). Sieťové nastavenie vychádza z [oficiálneho Tailscale Serve návodu](https://tailscale.com/docs/reference/tailscale-cli/serve).
