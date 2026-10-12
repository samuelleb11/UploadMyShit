//! Display names, room codes and the device description a browser reports. Everything a
//! visitor sends is shown to other visitors, so all of it is cleaned here.

use rand::seq::IndexedRandom;

const ADJECTIVES: &[&str] = &[
    "Amber", "Azure", "Bold", "Brave", "Bright", "Calm", "Clever", "Cosmic", "Crimson", "Daring",
    "Dusty", "Eager", "Electric", "Fancy", "Fierce", "Gentle", "Golden", "Happy", "Hidden", "Icy",
    "Jolly", "Keen", "Lucky", "Lunar", "Magic", "Mellow", "Mighty", "Misty", "Noble", "Olive",
    "Polar", "Proud", "Quick", "Quiet", "Rapid", "Rusty", "Scarlet", "Shiny", "Silent", "Silver",
    "Sleepy", "Smooth", "Snowy", "Solar", "Speedy", "Stormy", "Sunny", "Swift", "Tidy", "Turbo",
    "Velvet", "Vivid", "Wild", "Witty", "Zesty",
];

const ANIMALS: &[&str] = &[
    "Badger", "Bear", "Beaver", "Bison", "Bobcat", "Camel", "Cheetah", "Cobra", "Condor", "Coyote",
    "Crane", "Dingo", "Dolphin", "Eagle", "Falcon", "Ferret", "Fox", "Gazelle", "Gecko", "Heron",
    "Hippo", "Ibex", "Jaguar", "Koala", "Lemur", "Leopard", "Lion", "Llama", "Lynx", "Marmot",
    "Moose", "Narwhal", "Ocelot", "Octopus", "Orca", "Otter", "Owl", "Panda", "Panther", "Parrot",
    "Pelican", "Penguin", "Puffin", "Puma", "Quokka", "Raccoon", "Raven", "Seal", "Shark", "Sloth",
    "Squid", "Tapir", "Tiger", "Toucan", "Walrus", "Wolf", "Yak", "Zebra",
];

pub const MAX_NAME_CHARS: usize = 32;

pub fn random_name() -> String {
    let mut rng = rand::rng();
    let adjective = ADJECTIVES.choose(&mut rng).copied().unwrap_or("Swift");
    let animal = ANIMALS.choose(&mut rng).copied().unwrap_or("Otter");
    format!("{adjective} {animal}")
}

/// A display name with control and formatting characters removed and whitespace collapsed,
/// at most [`MAX_NAME_CHARS`] characters. `None` when nothing is left.
pub fn clean_name(raw: &str) -> Option<String> {
    let mut out = String::new();
    for word in raw.split_whitespace() {
        let word: String = word
            .chars()
            .filter(|c| !c.is_control() && !is_invisible(*c))
            .collect();
        if word.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&word);
    }
    let out: String = out.chars().take(MAX_NAME_CHARS).collect();
    let out = out.trim().to_string();
    (!out.is_empty()).then_some(out)
}

/// Zero-width and bidirectional controls: legal characters, but in a name they only serve
/// to make one device look like another.
fn is_invisible(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

/// A private room's code, lowercased: 4 to 64 of `a-z 0-9 - _`. `None` otherwise.
pub fn clean_room_code(raw: &str) -> Option<String> {
    let code = raw.trim().to_ascii_lowercase();
    let ok = (4..=64).contains(&code.len())
        && code
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_');
    ok.then_some(code)
}

/// One short field of the device description (kind, OS, browser): printable ASCII letters,
/// digits, spaces and `.-_`, at most 24 characters.
pub fn clean_device_field(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '-' | '_'))
        .take(24)
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_names_are_clean() {
        for _ in 0..50 {
            let n = random_name();
            assert_eq!(clean_name(&n).as_deref(), Some(n.as_str()));
        }
    }

    #[test]
    fn names_are_cleaned() {
        assert_eq!(
            clean_name("  Sam's \n  laptop\t").as_deref(),
            Some("Sam's laptop")
        );
        assert_eq!(clean_name("a\u{202E}b\u{200B}c").as_deref(), Some("abc"));
        assert_eq!(clean_name("\u{0007}\u{200B}"), None);
        assert_eq!(clean_name("   "), None);
        let long = "x".repeat(100);
        assert_eq!(clean_name(&long).unwrap().chars().count(), MAX_NAME_CHARS);
        assert_eq!(
            clean_name("Écran de Zoë 🦊").as_deref(),
            Some("Écran de Zoë 🦊")
        );
    }

    #[test]
    fn room_codes() {
        assert_eq!(clean_room_code(" AbC-123 ").as_deref(), Some("abc-123"));
        assert_eq!(clean_room_code("abc"), None);
        assert_eq!(clean_room_code("has space"), None);
        assert_eq!(clean_room_code("../etc"), None);
        assert_eq!(clean_room_code(&"a".repeat(65)), None);
    }

    #[test]
    fn device_fields() {
        assert_eq!(clean_device_field("Chrome 141<script>"), "Chrome 141script");
        assert_eq!(clean_device_field(&"y".repeat(40)).len(), 24);
    }
}
