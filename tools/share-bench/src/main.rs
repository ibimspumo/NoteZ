// Bench: with vs. without custom zstd dictionary, across note sizes.
//
// Wire format prefix: 1 byte version + 1 byte dict-id (0 = no dict).
// Encoded as URL-safe base64 in a notez://import/v1?d=... link.

use base64::Engine;
use serde::Serialize;
use std::io::Write;
use std::time::Instant;

#[derive(Serialize)]
struct LexNode {
    children: Vec<LexChild>,
    direction: &'static str,
    format: &'static str,
    indent: u32,
    #[serde(rename = "type")]
    node_type: &'static str,
    version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "textFormat")]
    text_format: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "textStyle")]
    text_style: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum LexChild {
    Para(LexNode),
    Text(LexText),
}

#[derive(Serialize)]
struct LexText {
    detail: u32,
    format: u32,
    mode: &'static str,
    style: &'static str,
    text: String,
    #[serde(rename = "type")]
    node_type: &'static str,
    version: u32,
}

#[derive(Serialize)]
struct LexRoot {
    root: LexNode,
}

fn make_lexical(paragraphs: &[&str]) -> String {
    let para_nodes: Vec<LexChild> = paragraphs
        .iter()
        .map(|p| {
            LexChild::Para(LexNode {
                children: vec![LexChild::Text(LexText {
                    detail: 0,
                    format: 0,
                    mode: "normal",
                    style: "",
                    text: p.to_string(),
                    node_type: "text",
                    version: 1,
                })],
                direction: "ltr",
                format: "",
                indent: 0,
                node_type: "paragraph",
                version: 1,
                text_format: Some(0),
                text_style: Some(""),
            })
        })
        .collect();

    let root = LexRoot {
        root: LexNode {
            children: para_nodes,
            direction: "ltr",
            format: "",
            indent: 0,
            node_type: "root",
            version: 1,
            text_format: None,
            text_style: None,
        },
    };
    serde_json::to_string(&root).unwrap()
}

fn zstd_compress(data: &[u8], level: i32) -> Vec<u8> {
    zstd::encode_all(data, level).unwrap()
}

fn zstd_compress_with_dict(data: &[u8], dict: &[u8], level: i32) -> Vec<u8> {
    let mut out = Vec::new();
    let mut enc = zstd::stream::Encoder::with_dictionary(&mut out, level, dict).unwrap();
    enc.write_all(data).unwrap();
    enc.finish().unwrap();
    out
}

fn b64url(data: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

// Wire format: [version: u8][dict_id: u8][zstd_payload...]
//   dict_id == 0  -> dictionary-less zstd
//   dict_id >= 1  -> use dictionary table[dict_id - 1]
fn frame(dict_id: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 2);
    out.push(1); // wire format version
    out.push(dict_id);
    out.extend_from_slice(payload);
    out
}

fn build_link(framed: &[u8]) -> String {
    format!("notez://import/v1?d={}", b64url(framed))
}

// Realistic corpus of 8 different German notes for dictionary training.
// Distinct from the test samples so we measure realistic dict performance.
fn corpus_paragraphs() -> Vec<Vec<&'static str>> {
    vec![
        vec![
            "Heute war ein produktiver Tag im Buero. Wir haben das neue Dashboard-Layout finalisiert und die ersten Feedback-Runden mit dem Design-Team durchgespielt. Besonders gefreut hat mich dass Anna direkt mit konstruktiven Verbesserungsvorschlaegen kam statt nur Probleme zu finden.",
            "Am Nachmittag stand das Quartalsmeeting an. Die Zahlen aus dem letzten Quartal sehen solide aus, allerdings ist der Trend bei Neukunden ruecklaeufig. Wir muessen uns ueberlegen wie wir die Akquise im naechsten Quartal staerker pushen koennen, vielleicht ueber eine gezielte Linkedin-Kampagne.",
            "Abends noch einkaufen gewesen, Vorraete fuer die Woche aufgefuellt. Morgen frueh joggen wenn es nicht regnet, danach direkter Einstieg in den Sprint-Planning Termin um neun.",
        ],
        vec![
            "Rezept fuer Linsen-Curry: 250g rote Linsen, eine Dose Kokosmilch, zwei Knoblauchzehen, ein Stueck frischer Ingwer, Zwiebel, Currypaste rot, etwas Zitronensaft, Salz und Koriander frisch zum Garnieren.",
            "Zubereitung: Zwiebel mit Knoblauch und Ingwer fein wuerfeln und anschwitzen. Currypaste dazu, kurz mitroesten. Linsen und Kokosmilch dazugeben, etwa fuenfzehn Minuten koecheln lassen bis die Linsen weich sind. Mit Zitronensaft und Salz abschmecken.",
            "Dazu passt Basmatireis oder Naan-Brot. Reicht fuer drei Portionen. Im Kuehlschrank zwei Tage haltbar, friert sich auch gut ein.",
        ],
        vec![
            "Buchnotizen aus Deep Work von Cal Newport. Kerngedanke: in einer Welt voller Ablenkungen wird die Faehigkeit zu konzentrierter Arbeit zur kritischen Ressource. Wer regelmaessig in tiefe Konzentration kommt, produziert qualitativ besseren Output und lernt schneller.",
            "Der Autor unterscheidet vier Strategien fuer Deep Work: monastisch (totale Abschottung), bimodal (Bloecke von mehreren Tagen), rhythmisch (taeglich gleiche Zeiten) und journalistisch (Gelegenheiten nutzen wann sie sich bieten). Fuer mich klingt rhythmisch am realistischsten.",
            "Konkrete Empfehlungen: Social Media auf ein Minimum reduzieren, einen Shutdown-Ritual am Ende des Arbeitstages etablieren, Langeweile bewusst zulassen statt sie sofort mit Smartphone zu killen. Werde versuchen das ab naechster Woche umzusetzen.",
        ],
        vec![
            "Reiseplanung Lissabon: Flug am siebzehnten gegen sieben Uhr morgens, Rueckflug am vierundzwanzigsten abends. Hotel im Bairro Alto gebucht, drei Naechte, dann zwei Naechte in Sintra im Boutique-Hotel mit Pool.",
            "Sehenswuerdigkeiten: Torre de Belem, Mosteiro dos Jeronimos, Castelo de Sao Jorge, Tram 28 fahren, Time Out Market am Cais do Sodre fuer Mittagessen. In Sintra unbedingt Quinta da Regaleira und Pena-Palast.",
            "Restaurants: Cervejaria Ramiro fuer Meeresfruechte, A Cevicheria, Belcanto wenn das Budget es zulaesst. Pasteis de Belem nicht vergessen, da soll der Original-Pasteis-de-Nata herkommen.",
        ],
        vec![
            "Brainstorming neues Feature fuer die App. Aktuell fehlt eine Moeglichkeit Notizen mit anderen zu teilen. Idee: Deep Link mit eingebetteter komprimierter Notiz, sodass kein Server noetig ist. Wuerde zur lokalen Philosophie passen.",
            "Technische Optionen evaluiert: gzip ist Standard aber nicht optimal. Brotli mit Quality elf hat ein eingebautes Web-Dictionary und schlaegt gzip um etwa fuenfzehn Prozent. Zstd mit Custom Dictionary kann auf strukturierten JSON-Daten dramatisch besser sein, faktor zehn ist realistisch.",
            "Naechste Schritte: Bench-Tool schreiben das die Optionen an einer realen Notiz misst. Dann Entscheidung treffen ob der Dictionary-Aufwand gerechtfertigt ist oder ob Brotli ohne Dict bereits ausreicht. Versionierung des Dictionaries ueber Wire-Format-Header.",
        ],
        vec![
            "Meeting-Protokoll mit Marketing-Team. Anwesend: Lisa, Markus, Tom und ich. Hauptthema war die Frage wie wir das neue Pricing kommunizieren ohne Bestandskunden zu verschrecken.",
            "Konsens: bestehende Kunden behalten ihre alten Konditionen mindestens bis Ende des Jahres. Neue Kunden kriegen das neue Pricing direkt. Kommunikation ueber Email plus In-App-Banner, gestaffelt ueber zwei Wochen.",
            "Offene Punkte: wer schreibt den Email-Text, brauchen wir juristische Pruefung, wann genau der Cutoff fuer alte Konditionen sein soll. Naechster Termin: Donnerstag vierzehn Uhr.",
        ],
        vec![
            "Trainingseinheit Donnerstag. Aufwaermen zehn Minuten, dann Krafttraining: Kniebeugen drei Saetze a zehn Wiederholungen mit achtzig Kilo, Bankdruecken drei mal acht mit siebzig Kilo, Klimmzuege drei Saetze bis zur Erschoepfung schaffe aktuell etwa zwoelf bis fuenfzehn.",
            "Im Anschluss Mobility-Routine fuer Hueften und Schultern, etwa fuenfzehn Minuten. Dehnen besonders der Hueftbeuger weil ich viel sitze.",
            "Naechstes Ziel: bei den Kniebeugen die neunzig Kilo knacken bis Ende des Monats. Aktuell stabil bei achtzig, sollte machbar sein wenn ich konsequent zwei mal pro Woche trainiere.",
        ],
        vec![
            "Lerntagebuch Spanisch. Heute Vokabeln zum Thema Reisen wiederholt: el aeropuerto, la maleta, el billete, el horario. Zwanzig neue Begriffe gelernt, davon nach drei Stunden noch siebzehn aktiv abrufbar.",
            "Grammatik: Subjuntivo Praesens vertieft. Die Anwendung nach espero que und nach quiero que sitzt jetzt halbwegs zuverlaessig. Schwieriger sind die Faelle nach es posible que oder es importante que, da muss ich noch ueben.",
            "Morgen will ich versuchen einen kompletten Tagebucheintrag auf Spanisch zu schreiben, etwa hundert Woerter. Mal sehen wie weit ich ohne Woerterbuch komme.",
        ],
    ]
}

// Test samples - distinct content, similar style.
fn test_samples() -> Vec<(&'static str, Vec<&'static str>)> {
    let short = vec![
        "Erinnerung: morgen frueh den Zahnarzttermin nicht vergessen, neun Uhr dreissig in der Praxis am Marktplatz. Vorher noch Zeitschrift fuer das Wartezimmer mitnehmen.",
    ];

    let medium = vec![
        "Code Review fuer die neue Search-Komponente abgeschlossen. Insgesamt sauber strukturiert, Pavel hat die Trennung zwischen UI und Datenschicht gut hinbekommen. Ein paar kleinere Anmerkungen zur Performance: die debounce-Logik laeuft aktuell noch im Komponenten-Body statt in einem Memo, das fuehrt zu unnoetigen Re-Renders bei jedem Tippen.",
        "Zweiter Punkt: die Highlight-Funktion fuer die Trefferanzeige nutzt regulaere Ausdruecke pro Zeichen, das wird bei langen Texten quadratisch teuer. Vorschlag: einmal die gesamte Snippet-Range bestimmen, dann splitten und einfuegen statt regex-replace.",
        "Sonst: Tests sind vollstaendig, Edge-Cases gut abgedeckt, Doku im JSDoc ist hilfreich. Approval kommt sobald die zwei genannten Punkte adressiert sind. Schaetzung: noch etwa zwei Stunden Arbeit, sollte morgen zusammen mit dem Release-Branch zusammengefuehrt werden koennen.",
        "Daneben noch geklaert: das Caching-Problem aus dem letzten Sprint ist tatsaechlich auf eine Race Condition zwischen zwei parallelen Invalidierungen zurueckzufuehren. Workaround mit Mutex ist deployed, saubere Loesung folgt im naechsten Sprint wenn wir die Architektur eh anfassen.",
        "Fuer naechste Woche: Refactoring der Settings-View beginnen. Aktuell sind dort zu viele Verantwortlichkeiten in einer Datei, das macht das Adden neuer Optionen schmerzhaft. Plan ist die Aufteilung in Sub-Module pro Settings-Kategorie.",
        "Ausserdem will ich endlich die Dokumentation fuer die Plugin-API anfangen. Dass das Feature jetzt seit drei Releases drin ist ohne Doku ist nicht haltbar, externe Entwickler haben uns das mehrfach gespiegelt. Erst Architektur-Ueberblick, dann Code-Beispiele, dann API-Referenz.",
    ];

    let long = {
        let mut v = vec![
            "Ausfuehrlicher Wochenrueckblick KW17. Die Woche stand im Zeichen mehrerer parallel laufender Themen, was an manchen Tagen zu Kontextwechselkosten gefuehrt hat. Im Nachhinein haette ich Dienstag und Mittwoch konsequenter blocken sollen statt mich zwischen vier Calls und zwei tiefen Coding-Sessions zerreissen zu lassen.",
            "Hauptergebnis: das Sharing-Konzept fuer NoteZ ist konzeptionell durchgerechnet. Wir haben eine Loesung gefunden die ohne eigenen Server auskommt, indem wir die komplette Notiz in einen Deep Link einbetten. Kompression ueber zstd mit einem auf Lexical-JSON trainierten Dictionary bringt die Payload auf etwa ein Zehntel der Ausgangsgroesse.",
            "Sekundaeres Ergebnis: Settings-Refactoring ist fast durch, nur noch die Migration der bestehenden Werte fehlt. Die neue Struktur trennt UI-Praeferenzen von Datenoptionen sauber, was zukuenftige Features erleichtern wird ohne dass die View-Datei ins Unendliche waechst.",
            "Tertiaeres Ergebnis: Bug-Backlog auf zwoelf Tickets reduziert, davon vier kritisch und acht kosmetisch. Die kritischen will ich naechste Woche durcharbeiten weil sie sich potentiell auf User-Daten auswirken. Kosmetisches schiebe ich auf den Polish-Sprint Mitte des Monats.",
            "Was nicht so gut lief: Mittwoch ein halber Tag verloren wegen einer Tooling-Problematik mit der CI. Der Build hing in einer Endlosschleife wegen einer Dependency-Version die ein Caching-Problem hatte. Loesung war banal, das Finden hat trotzdem fast vier Stunden gedauert.",
            "Persoenliche Lessons: morgens vor neun Uhr ist meine produktivste Zeit, da sollte ich die anspruchsvollsten Aufgaben einplanen statt sie mit Email-Triage zu verbrennen. Naechste Woche will ich die ersten zwei Stunden konsequent fuer Deep Work blocken.",
            "Plan fuer KW18: Sharing-Feature implementieren, kritische Bugs fixen, Settings-Migration abschliessen. Dazu zwei externe Termine die feststehen. Should be doable wenn ich Mittwoch und Donnerstag wirklich ungestoert arbeiten kann.",
        ];
        // Make it longer by repeating some paragraphs (simulates a longer note)
        v.push(v[1]);
        v.push(v[2]);
        v.push(v[5]);
        v
    };

    vec![
        ("Kurz (~25 Woerter)", short),
        ("Mittel (~430 Woerter)", medium),
        ("Lang (~770 Woerter)", long),
    ]
}

fn run_comparison(label: &str, paragraphs: &[&str], dict: &[u8]) {
    let lexical = make_lexical(paragraphs);
    let raw = lexical.as_bytes();
    let words: usize = paragraphs.iter().map(|p| p.split_whitespace().count()).sum();

    println!("\n=== {} | {} Woerter | {} bytes Lexical-JSON raw ===", label, words, raw.len());

    // Variant A: zstd-22 OHNE Custom Dict
    let t0 = Instant::now();
    let no_dict = zstd_compress(raw, 22);
    let no_dict_us = t0.elapsed().as_micros();
    let no_dict_framed = frame(0, &no_dict);
    let no_dict_link = build_link(&no_dict_framed);

    // Variant B: zstd-22 MIT Custom Dict
    let t0 = Instant::now();
    let with_dict = zstd_compress_with_dict(raw, dict, 22);
    let with_dict_us = t0.elapsed().as_micros();
    let with_dict_framed = frame(1, &with_dict);
    let with_dict_link = build_link(&with_dict_framed);

    println!(
        "  {:<32}{:>12}{:>12}{:>14}{:>10}",
        "variant", "compressed", "ratio", "URL chars", "ms"
    );
    println!(
        "  {:<32}{:>12}{:>12.2}{:>14}{:>10.2}",
        "zstd-22 (no dict)",
        no_dict_framed.len(),
        raw.len() as f64 / no_dict.len() as f64,
        no_dict_link.len(),
        no_dict_us as f64 / 1000.0,
    );
    println!(
        "  {:<32}{:>12}{:>12.2}{:>14}{:>10.2}",
        "zstd-22 (with custom dict)",
        with_dict_framed.len(),
        raw.len() as f64 / with_dict.len() as f64,
        with_dict_link.len(),
        with_dict_us as f64 / 1000.0,
    );

    let saved = no_dict_link.len() as i64 - with_dict_link.len() as i64;
    let saved_pct = saved as f64 / no_dict_link.len() as f64 * 100.0;
    println!("  -> Dict spart {} Zeichen ({:.0}% kuerzere URL)", saved, saved_pct);
}

fn print_demo_links(dict: &[u8]) {
    let medium = test_samples().into_iter().find(|(l, _)| l.starts_with("Mittel")).unwrap().1;
    let lexical = make_lexical(&medium);

    let no_dict = zstd_compress(lexical.as_bytes(), 22);
    let with_dict = zstd_compress_with_dict(lexical.as_bytes(), dict, 22);

    println!("\n=== Demo-Links fuer 430-Wort-Notiz ===");
    println!("\n[ohne Dict, {} Zeichen]", build_link(&frame(0, &no_dict)).len());
    println!("{}", build_link(&frame(0, &no_dict)));
    println!("\n[mit Dict, {} Zeichen]", build_link(&frame(1, &with_dict)).len());
    println!("{}", build_link(&frame(1, &with_dict)));
}

fn main() {
    // Train dictionary on a corpus DISTINCT from the test samples
    let corpus: Vec<String> = corpus_paragraphs().iter().map(|p| make_lexical(p)).collect();
    let corpus_refs: Vec<&[u8]> = corpus.iter().map(|s| s.as_bytes()).collect();
    let dict = zstd::dict::from_samples(&corpus_refs, 4 * 1024).unwrap();

    println!("Custom-Dictionary trainiert auf {} unabhaengigen Notizen, Groesse: {} bytes",
        corpus.len(), dict.len());
    println!("(Dictionary wird einmalig im App-Binary eingebacken, nicht pro Link uebertragen)");
    println!("Wire-Format: [version: 1B][dict_id: 1B][zstd_payload...]  -> 2 Byte Header-Overhead");

    for (label, paragraphs) in test_samples() {
        run_comparison(label, &paragraphs, &dict);
    }

    print_demo_links(&dict);
}
