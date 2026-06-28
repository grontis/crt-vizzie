const CYBER_SKULL: &[&str] = &[
    "+--[ SEG_FAULT @ 0xDEADBEEF ]----------+",
    "| ░▒▓ KERNEL_PANIC :: STACK_DUMP  ▓▒░  |",
    "|       ▄▄▓▓████████████▓▓▄▄           |",
    "|    ▄▓██░░░░░░░░░░░░░░░░██▓▄          |",
    "|  ▄██░░01001000░░01101001░░██▄        |",
    "| ██░░▓▓▓▓░░░░░░░░░░░░▓▓▓▓░░██         |",
    "| █░░▓▒▒▒▓░░░▓▓▓▓▓▓░░░▓▒▒▒▓░░█         |",
    "| █░░▓▒█▒▓░░▓██░░██▓░░▓▒█▒▓░░█         |",
    "| █░░▓▒▒▒▓░░░▓▓▓▓▓▓░░░▓▒▒▒▓░░█         |",
    "| ██░░▓▓▓░░░░░░██░░░░░░▓▓▓░░██         |",
    "|  ██░░░░░░░██████░░░░░░░░██           |",
    "|   ██░│║│║│║│║│║│║│║│║│░██            |",
    "|    ██░░╲══════════════╱░██           |",
    "|     ▀████▓▓████▓▓████▀               |",
    "+--------------------------------------+",
    "| > 4D 45 4D 5F 44 55 4D 50 5F 46 41 4 |",
    "| > 0xFF 0xAB 0xCD 0xEF 0xC0 0xFF 0xEE |",
    "| > [████████████████░░░░] 81% CORRUPT |",
    "| > LINK_LOST.. RECONNECTING  ▓▒░▒▓    |",
    "+--------------------------------------+",
];

const ARCANE_EYE: &[&str] = &[
    "        ✦   .  *  .   ✦   .   *         ",
    "     ✧       ╱─────────╲      ✧         ",
    "        .  ╱   † ‡ † ‡   ╲  .           ",
    "     *   ╱  .─────────.   ╲   *         ",
    "       ╱  ╱    ▄▄▄▄▄    ╲   ╲           ",
    "      │  │   ▄█▀░░░▀█▄   │  │           ",
    "   †  │  │  █░░▄███▄░░█  │  │  ‡        ",
    "      │  │  █░█░◉ ◉░█░█  │  │           ",
    "      │  │  █░░▀███▀░░█  │  │           ",
    "   ‡  │  │   ▀█▄░░░▄█▀   │  │  †        ",
    "       ╲  ╲    ▀▀▀▀▀    ╱   ╱           ",
    "        ╲  '─────────'   ╱              ",
    "     ✧   ╲   ‡ † ‡ †   ╱   ✧            ",
    "        .  ╲─────────╱  .               ",
    "       *      ╲ ║ ╱      *   .          ",
    "     ✦    ▄▄▄▄▄║▄▄▄▄▄    ✦              ",
    "        ░▒▓██████████▓▒░                ",
    "       ░▒▓ SIGIL_LV.7 ▓▒░               ",
    "       ░▒▓ EYE_OPEN ▓▒░                 ",
    "        .   *    .    *                 ",
];

const RUNE_TOWER: &[&str] = &[
    "              ╱╲              .         ",
    "         ★   ╱  ╲   ★      .            ",
    "            ╱ ◈◈ ╲       ✧              ",
    "       .   ╱══════╲    .       .        ",
    "          │ ☽    ☾ │                    ",
    "          │ ┌────┐ │      ▒▓            ",
    "   ✧      │ │ ▓▓ │ │  .   ░▒▓           ",
    "       .  │ │ ██ │ │      ░▒▓░          ",
    "          │ └────┘ │                    ",
    "          │ †††††† │   .                ",
    "          ╞════════╡                    ",
    "          │ ╔════╗ │      .             ",
    "       .  │ ║0xF7║ │                    ",
    "          │ ╚════╝ │   ✧                ",
    "          │  ║║║║  │ .                  ",
    "          │  ║║║║  │                    ",
    "       ╔══╧══════╧══╗   .               ",
    "       ║ ░▒▓████▓▒░ ║                   ",
    "   ░▒▓░║▓▓██████████▓▓║░▒▓              ",
    "   ░░░░╚════════════╝░░░░               ",
];

const NEURAL_GRID: &[&str] = &[
    "  ◉───────◉───────◉───────◉───────◉     ",
    "  │╲     ╱│╲     ╱│╲     ╱│╲     ╱│     ",
    "  │ ╲   ╱ │ ╲   ╱ │ ╲   ╱ │ ╲   ╱ │     ",
    "  │  ╲ ╱  │  ╲ ╱  │  ╲ ╱  │  ╲ ╱  │     ",
    "  │   ◈   │   ◈   │   ◈   │   ◈   │     ",
    "  │  ╱ ╲  │  ╱ ╲  │  ╱ ╲  │  ╱ ╲  │     ",
    "  │ ╱   ╲ │ ╱   ╲ │ ╱   ╲ │ ╱   ╲ │     ",
    "  │╱     ╲│╱     ╲│╱     ╲│╱     ╲│     ",
    "  ◉───────◉───────◉───────◉───────◉     ",
    "  │╲ 0.7 ╱│╲ 0.2 ╱│╲ 0.9 ╱│╲ 0.4 ╱│     ",
    "  │ ╲   ╱ │ ╲   ╱ │ ╲   ╱ │ ╲   ╱ │     ",
    "  │  ╲ ╱  │  ╲ ╱  │  ╲ ╱  │  ╲ ╱  │     ",
    "  │   ◆   │   ◆   │   ◆   │   ◆   │     ",
    "  │  ╱ ╲  │  ╱ ╲  │  ╱ ╲  │  ╱ ╲  │     ",
    "  │ ╱   ╲ │ ╱   ╲ │ ╱   ╲ │ ╱   ╲ │     ",
    "  │╱     ╲│╱     ╲│╱     ╲│╱     ╲│     ",
    "  ◉───────◉───────◉───────◉───────◉     ",
    "   LAYER_03 :: ACTIVATION ▓▓▓░░░░       ",
    "   ∑w·x + b → σ(z) → backprop ⟲         ",
    "   gradient: -0.0042  loss: 0.317       ",
];

const PORTAL_RIFT: &[&str] = &[
    "   *  .    ✧    .   ✦   .    *          ",
    "      .   ╱─────────╲    .  ✧           ",
    "   ✦    ╱  ░▒▓▓▓▒░  ╲     .             ",
    "       ╱  ▒▓██▓██▓▒  ╲                  ",
    "   .  │  ▓██▀░░░▀██▓  │   *             ",
    "      │ ▓█░  ╱│╲  ░█▓ │                 ",
    "   *  │ █░  ╱ ◉ ╲  ░█ │ ✧               ",
    "      │ █  │ ╱│╲ │  █ │                 ",
    "      │ █  │╱─┼─╲│  █ │                 ",
    "   ✧  │ █░  ╲ ◉ ╱  ░█ │ .               ",
    "      │ ▓█░  ╲│╱  ░█▓ │                 ",
    "      │  ▓██▄░░░▄██▓  │  ✦              ",
    "   .   ╲  ▒▓██▓██▓▒  ╱                  ",
    "        ╲  ░▒▓▓▓▒░  ╱   .               ",
    "     ✦   ╲─────────╱  ✧                 ",
    "        .    ║║║    .                   ",
    "        ░▒▓██║║║██▓▒░    *              ",
    "   ✧   RIFT_OPEN [v∞.∞]                 ",
    "        > coord: NULL_SPACE             ",
    "        *   .   ✦    .                  ",
];

const SUMMONING_CIRCLE: &[&str] = &[
    "   .   ✦   ╔════════════╗   ✦   .       ",
    "       ✧   ║ ⌬  ⌘  ⌬  ⌘ ║   ✧           ",
    "   ✦      ╔╝            ╚╗      ✦       ",
    "        ╔═╝   ▄▄▄▄▄▄▄    ╚═╗            ",
    "   ⌬   ╔╝   ▓░░░░░░░▓     ╚╗   ⌬        ",
    "       ║  ▓░░ ▄▄▄▄ ░░▓     ║            ",
    "   †   ║ ▓░░▄█████▄░░▓     ║   ‡        ",
    "       ║ ▓░██▀░░░▀██░▓     ║            ",
    "   ‡   ║ ▓░█░░◉◇◉░░█░▓     ║   †        ",
    "       ║ ▓░██▄░░░▄██░▓     ║            ",
    "   ⌘   ║  ▓░░▀████▀░░▓     ║   ⌘        ",
    "       ╚╗   ▓░░░░░░░▓     ╔╝            ",
    "        ╚═╗   ▀▀▀▀▀▀▀    ╔═╝            ",
    "   ✦      ╚╗            ╔╝      ✦       ",
    "       ✧   ║ † ‡ ⌬ ‡ †  ║   ✧           ",
    "   .   ✦   ╚════════════╝   ✦   .       ",
    "       ░▒▓ INVOKE :: lvl 9 ▓▒░          ",
    "        > sigil_lock: ENGAGED           ",
    "       > pact_signed: 0xC0DE            ",
    "        ✧    .   ✦   .   ✧              ",
];

const DRAGON_CORE: &[&str] = &[
    "                ╱╲╱╲╱╲╱╲                ",
    "            ╱──┘        └──╲            ",
    "        ╱──┘  ▄▄         ▄▄  └──╲       ",
    "      ╱┘    ▄██░         ░██▄    └╲     ",
    "    ╱┘    ▄█░░◉           ◉░░█▄    └╲   ",
    "   │    ▄█░░░░░  ╔═══╗  ░░░░░█▄     │   ",
    "   │   █░░░▒▒▒░░ ║▓▓▓║ ░░▒▒▒░░░█    │   ",
    "   │  █░░▓████▓░╔╝▓▓▓╚╗░▓████▓░░█   │   ",
    "   │  █░░▓█░░█▓ ║░░░░░║ ▓█░░█▓░░█   │   ",
    "   │   █░░▓▓▓▓░╔╝▒▒▒▒▒╚╗░▓▓▓▓░░█    │   ",
    "   │    ▀█░░░░ ║▓░░░░░▓║ ░░░░█▀     │   ",
    "   │      ▀█▓▓ ╚═══════╝ ▓▓█▀       │   ",
    "    ╲      ▀▓▓▓░░░░░░░░░▓▓▓▀       ╱    ",
    "     ╲╲       ▀▀▓▓▓▓▓▓▓▀▀         ╱╱    ",
    "       ╲╲╲      ░╲╲║╱╱░         ╱╱╱     ",
    "          ╲╲     ░╲║╱░         ╱╱       ",
    "            ╲╲    ░║░         ╱╱        ",
    "   ░▒▓ SYS::WYRM_CORE.exe ▓▒░           ",
    "       > heat: 9001  status: ALIVE      ",
    "        ▼  ▼  ▼  ▼  ▼  ▼  ▼             ",
];

const MATRIX_RAIN: &[&str] = &[
    "F . A 3 9 . C E . 1 7 . F 3 A 0 B . D 2 ",
    ". E F . 2 . B . . E . . D . . 9 . 3 . F ",
    "8 . . E 1 C 8 D . 4 F . . 8 . . 2 . . 5 ",
    "2 . B . F . 5 . . 7 4 . 9 . . C . 6 . . ",
    ". 3 . . C . . D E . . 7 6 F . C A 0 B . ",
    "F . F . 2 9 B . . E . . D . 3 . . . 3 . ",
    ". . . ▓ 1 C 8 D . 4 F . . 8 . . 2 . . 5 ",
    "2 . B . F . ▓ . . 7 4 . 9 . ▓ C . 6 . . ",
    ". 3 . . ▓ . . D E . . ▓ 6 F . ▓ A 0 B . ",
    "8 . . E . 1 C 8 ▓ . 4 F . . 8 . . 2 . . ",
    ". . F . . . . . . D . . . 9 . . . F . . ",
    ". . . . . F . . . . . . . . . . 3 . . . ",
    "+--------------------------------------+",
    "| > DECODING STREAM......              |",
    "| > KEY: 0xC0FFEEBA  IV: 0xDEADBEEF    |",
    "| > [████████████████░░░] 78%          |",
    "| > origin: irc.darknet.onion:6667     |",
    "| > packets: 1337  dropped: 42         |",
    "| > [ESC=abort]    [F1=trace]          |",
    "+--------------------------------------+",
];

const HEX_DUMP: &[&str] = &[
    ".::[ MEMDUMP /dev/null @ 0x00400000 ]::.",
    " ┌─────────────────────────────────────┐",
    " │ 0000  4D 5A 90 00 03 00 00 00 │MZ ..│",
    " │ 0008  04 00 00 00 FF FF 00 00 │.....│",
    " │ 0010  B8 00 00 00 00 00 00 00 │.....│",
    " │ 0018  40 00 00 00 00 00 00 00 │@....│",
    " │ 0020  DE AD BE EF DE AD BE EF │.....│",
    " │ 0028  CA FE BA BE CA FE BA BE │.....│",
    " │ 0030  C0 FF EE 13 37 D0 0D EA │.....│",
    " │ 0038  FE ED FA CE FE ED FA CE │.....│",
    " │ 0040  ░▒▓░▒▓░▒▓░▒▓░▒▓░▒▓░▒▓░▒ │░▒▓░▒│",
    " │ 0048  __FBI_OPEN_UP__ FBI FBI │ ! ? │",
    " └─────────────────────────────────────┘",
    "> scanning for shellcode patterns ...   ",
    "> matched signature: 0xC0DE_INJECT      ",
    "> entropy: 7.93 / 8.00  (suspicious)    ",
    "> [ ALERT ] possible payload detected   ",
    "> forwarding to honeypot ... [DONE]     ",
    "> dump_size: 1024 bytes / sha: 0xBADF00D",
    "> [ press ENTER to acknowledge ]      _ ",
];

const TERMINAL_BREACH: &[&str] = &[
    "┌─[ target.gov:22 ]──[ PWND ]──────────┐",
    "│ $ ssh root@target.gov                │",
    "│ Connecting ...                       │",
    "│ Permission denied (publickey)        │",
    "│ $ ./crack.py --dict rockyou.txt      │",
    "│ [+] testing 0xDEADBEEF .. fail       │",
    "│ [+] testing hunter2 ........ fail    │",
    "│ [+] testing CORRECTHORSE .. HIT!     │",
    "│ root@target:~# whoami                │",
    "│ root                                 │",
    "│ root@target:~# cat /etc/shadow       │",
    "│ root:$6$x9k...:18923:0:99999:7:::    │",
    "│ root@target:~# nc 10.0.0.1 1337 < .  │",
    "│ ████████████████████░░░░░ 82% sent   │",
    "└──────────────────────────────────────┘",
    "> tunneling via tor exit-node #4F2A     ",
    "> opsec: dns-over-https / mac-spoof     ",
    "> [ wipe ~/.bash_history before exit ]  ",
    "> session uptime: 00:04:17  idle: 0s    ",
    "> _                                     ",
];

const CIRCUIT_BOARD: &[&str] = &[
    "┌──────[ MAIN BOARD v2.1 ]─────────────┐",
    "│ ┌─[R1]─┐   ┌──────────┐  ┌─[C1]──┐   │",
    "│ │ 330Ω │   │  ┌────┐  │  │ 10μF  │   │",
    "│ └───┬──┘   │  │ CPU│  │  └───┬───┘   │",
    "│     ├──────┤  │8086│  ├──────┤       │",
    "│     │      │  └────┘  │      │       │",
    "│  ┌──┴──┐   │  ┌────┐  │   ┌──┴──┐    │",
    "│  │ IC1 │   │  │ ROM│  │   │ IC2 │    │",
    "│  │74LS │   │  │64KB│  │   │ 138 │    │",
    "│  └──┬──┘   │  └────┘  │   └──┬──┘    │",
    "│     │      └─────┬────┘      │       │",
    "│  ┌──┴───┐    ┌───┴────┐   ┌──┴──┐    │",
    "│  │ XTAL │    │ DRAM   │   │ I/O │    │",
    "│  │ 16MHz│    │ 256KB  │   │ PORT│    │",
    "│  └──────┘    └────────┘   └─────┘    │",
    "├──╦═══════════════════════════════╦───┤",
    "│  ║ ░▓ 5V ▓░   ░▓ STATUS:OK ▓░    ║   │",
    "└──╩═══════════════════════════════╩───┘",
    "   ╨  ╨  ╨  ╨  ╨  ╨  ╨  ╨  ╨  ╨         ",
    "> bus_freq: 16MHz  ░▓ trace_id:7E ▓░    ",
];

const PACKET_FLOW: &[&str] = &[
    "   ┌──[CLIENT]──┐                       ",
    "   │ 10.0.0.42  │      ━━ TCP/443 ▶     ",
    "   └──────┬─────┘                       ",
    "          │           ░▒▓ HTTPS ▓▒░     ",
    "          ▼                             ",
    "   ┌─────────[ FIREWALL ]──────────┐    ",
    "   │ rules:247  blocked:1.2k   ✓   │    ",
    "   └──────┬────────────────────────┘    ",
    "          │                             ",
    "          ├─━▶ [LB] ━━━━━━━━━━━━┓       ",
    "          │                     ▼       ",
    "          │     ┌─[N1]─┐   ┌─[N2]─┐     ",
    "          │     │ 34%  │   │ 67%  │     ",
    "          ▼     └──────┘   └──────┘     ",
    "   ┌─[DB_PRIMARY]─┐   ┌─[CACHE]─┐       ",
    "   │ pg-01  ●●●   │   │ redis   │       ",
    "   └──────────────┘   └─────────┘       ",
    "> tcpdump: 4729 pkts / 0 dropped        ",
    "> latency: p50=4ms  p99=23ms            ",
    "> 0xACAB-FEED-FACE-CAFE   AUTH:OK       ",
];

// ── Figure registry ──────────────────────────────────────────────────────────

pub struct Figure {
    pub name: &'static str,
    pub rows: &'static [&'static str],
}

pub const FIGURES: &[Figure] = &[
    Figure { name: "cyber_skull",       rows: CYBER_SKULL },
    Figure { name: "arcane_eye",        rows: ARCANE_EYE },
    Figure { name: "rune_tower",        rows: RUNE_TOWER },
    Figure { name: "neural_grid",       rows: NEURAL_GRID },
    Figure { name: "portal_rift",       rows: PORTAL_RIFT },
    Figure { name: "summoning_circle",  rows: SUMMONING_CIRCLE },
    Figure { name: "dragon_core",       rows: DRAGON_CORE },
    Figure { name: "matrix_rain",       rows: MATRIX_RAIN },
    Figure { name: "hex_dump",          rows: HEX_DUMP },
    Figure { name: "terminal_breach",   rows: TERMINAL_BREACH },
    Figure { name: "circuit_board",     rows: CIRCUIT_BOARD },
    Figure { name: "packet_flow",       rows: PACKET_FLOW },
];

/// Return a figure by RNG value — caller computes `rng_val = (rng.rand() * FIGURES.len() as f32) as usize`.
pub fn random_figure_idx(rng_val: usize) -> &'static Figure {
    &FIGURES[rng_val % FIGURES.len()]
}

/// Return a figure by name, falling back to the first figure if not found.
#[allow(dead_code)]
pub fn get_figure(name: &str) -> &'static Figure {
    FIGURES.iter().find(|f| f.name == name).unwrap_or(&FIGURES[0])
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_figures_have_20_rows() {
        assert_eq!(FIGURES.len(), 12, "expected 12 figures");
        for fig in FIGURES {
            assert_eq!(
                fig.rows.len(),
                20,
                "figure '{}' has {} rows, expected 20",
                fig.name,
                fig.rows.len()
            );
        }
    }

    /// Verifies that every character in the KATAKANA pool, GLI_CHARS pool, and
    /// ascii_art figure strings (non-space) is present in the baked atlas charset.
    ///
    /// A failure here means `fusion.rs`'s "char not in atlas" warning path WOULD fire
    /// at runtime, producing silent blank cells and a console warning.
    #[test]
    fn atlas_charset_covers_all_native_pools() {
        // Load the baked atlas.json at compile time.
        let atlas_json = include_str!("../assets/atlas.json");

        // Given a char, return the string that would appear in the atlas JSON charset
        // array. Handles the two chars that JSON requires escaping: \ and ".
        let json_repr = |ch: char| -> String {
            match ch {
                '\\' => "\"\\\\\"".to_string(),  // JSON: "\\"
                '"'  => "\"\\\"\"".to_string(),   // JSON: "\""
                _    => format!("\"{}\"", ch),
            }
        };

        let assert_char = |ch: char, context: &str| {
            let repr = json_repr(ch);
            assert!(
                atlas_json.contains(repr.as_str()),
                "char {:?} (U+{:04X}) required by {} is missing from the baked atlas charset",
                ch, ch as u32, context
            );
        };

        // Check KATAKANA pool (96 katakana + 25 ASCII hex+symbols = 121 entries)
        for &ch in crate::config::KATAKANA {
            assert_char(ch, "KATAKANA pool");
        }

        // Check GLI_CHARS pool (glitch layer random character source)
        for ch in crate::config::GLI_CHARS.chars() {
            assert_char(ch, "GLI_CHARS pool");
        }

        // Check every non-space char in every figure row
        for fig in FIGURES {
            for row in fig.rows {
                for ch in row.chars() {
                    if ch != ' ' {
                        assert_char(ch, fig.name);
                    }
                }
            }
        }
    }
}
