//! Who is connecting: the visitor's address behind trusted proxies, and the network room it
//! belongs to.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::str::FromStr;

use axum::http::HeaderMap;

/// An address block, `10.0.0.0/8` or `fd00::/8`. A bare address is a /32 or /128.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cidr {
    addr: IpAddr,
    prefix: u8,
}

impl Cidr {
    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr, canonical(ip)) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => mask_v4(ip, self.prefix) == net,
            (IpAddr::V6(net), IpAddr::V6(ip)) => mask_v6(ip, self.prefix) == net,
            _ => false,
        }
    }
}

impl FromStr for Cidr {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let s = s.trim();
        let (addr, prefix) = match s.split_once('/') {
            Some((a, p)) => (a, Some(p)),
            None => (s, None),
        };
        let addr: IpAddr = addr
            .parse()
            .map_err(|_| format!("{s:?} is not an address"))?;
        let addr = canonical(addr);
        let max = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix {
            Some(p) => p
                .parse::<u8>()
                .ok()
                .filter(|p| *p <= max)
                .ok_or_else(|| format!("{s:?} has a bad prefix length"))?,
            None => max,
        };
        Ok(Cidr {
            addr: mask(addr, prefix),
            prefix,
        })
    }
}

impl fmt::Display for Cidr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.addr, self.prefix)
    }
}

/// An IPv4-mapped IPv6 address (`::ffff:1.2.3.4`, what a dual-stack socket reports) as the
/// IPv4 address it is.
pub fn canonical(ip: IpAddr) -> IpAddr {
    ip.to_canonical()
}

fn mask_v4(ip: Ipv4Addr, prefix: u8) -> Ipv4Addr {
    let bits = u32::from(ip);
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - u32::from(prefix))
    };
    Ipv4Addr::from(bits & mask)
}

fn mask_v6(ip: Ipv6Addr, prefix: u8) -> Ipv6Addr {
    let bits = u128::from(ip);
    let mask = if prefix == 0 {
        0
    } else {
        u128::MAX << (128 - u32::from(prefix))
    };
    Ipv6Addr::from(bits & mask)
}

fn mask(ip: IpAddr, prefix: u8) -> IpAddr {
    match ip {
        IpAddr::V4(v4) => IpAddr::V4(mask_v4(v4, prefix)),
        IpAddr::V6(v6) => IpAddr::V6(mask_v6(v6, prefix)),
    }
}

/// How the visitor's address is found.
#[derive(Debug, Clone, Default)]
pub struct ClientIpPolicy {
    /// Lowercase header name, read only when the TCP peer is trusted.
    pub header: Option<String>,
    pub trusted: Vec<Cidr>,
}

impl ClientIpPolicy {
    fn is_trusted(&self, ip: IpAddr) -> bool {
        self.trusted.iter().any(|c| c.contains(ip))
    }

    /// The visitor's address. The TCP peer, unless it is a trusted proxy and sent the header;
    /// then the right-most address in the header that is not itself a trusted proxy. Every
    /// proxy appends what it saw, so entries left of the first untrusted one are whatever the
    /// visitor chose to send and are never believed.
    pub fn client_ip(&self, peer: SocketAddr, headers: &HeaderMap) -> IpAddr {
        let peer_ip = canonical(peer.ip());
        let Some(name) = &self.header else {
            return peer_ip;
        };
        if !self.is_trusted(peer_ip) {
            return peer_ip;
        }
        let chain: Vec<IpAddr> = headers
            .get_all(name.as_str())
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .filter_map(parse_forwarded_entry)
            .collect();
        chain
            .iter()
            .rev()
            .copied()
            .find(|ip| !self.is_trusted(*ip))
            // Every hop trusted: the visitor is inside the trusted network itself.
            .or_else(|| chain.first().copied())
            .unwrap_or(peer_ip)
    }
}

/// One X-Forwarded-For entry: a bare address, or one with a port (`1.2.3.4:5678`,
/// `[2001:db8::1]:443`), which some proxies write.
fn parse_forwarded_entry(entry: &str) -> Option<IpAddr> {
    let entry = entry.trim().trim_matches('"');
    entry
        .parse::<IpAddr>()
        .ok()
        .or_else(|| entry.parse::<SocketAddr>().ok().map(|s| s.ip()))
        .map(canonical)
}

/// The automatic room for a visitor address: every device behind one public IPv4 address,
/// or in one IPv6 prefix, shares it.
pub fn network_room_key(ip: IpAddr, ipv4_prefix: u8, ipv6_prefix: u8) -> String {
    let ip = canonical(ip);
    let prefix = if ip.is_ipv4() {
        ipv4_prefix
    } else {
        ipv6_prefix
    };
    format!("net:{}/{}", mask(ip, prefix), prefix)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn policy(header: &str, trusted: &[&str]) -> ClientIpPolicy {
        ClientIpPolicy {
            header: Some(header.to_string()),
            trusted: trusted.iter().map(|c| c.parse().unwrap()).collect(),
        }
    }

    fn headers(name: &'static str, values: &[&str]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for v in values {
            h.append(name, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    fn sock(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    #[test]
    fn cidr_parsing_and_matching() {
        let c: Cidr = "10.1.2.3/8".parse().unwrap();
        assert_eq!(c.to_string(), "10.0.0.0/8");
        assert!(c.contains("10.200.0.1".parse().unwrap()));
        assert!(!c.contains("11.0.0.1".parse().unwrap()));
        assert!(c.contains("::ffff:10.0.0.9".parse().unwrap()));
        let v6: Cidr = "fd00::/8".parse().unwrap();
        assert!(v6.contains("fdab::1".parse().unwrap()));
        assert!(!v6.contains("10.0.0.1".parse().unwrap()));
        assert_eq!("1.2.3.4".parse::<Cidr>().unwrap().to_string(), "1.2.3.4/32");
        assert!("10.0.0.0/33".parse::<Cidr>().is_err());
        assert!("nope/8".parse::<Cidr>().is_err());
    }

    #[test]
    fn untrusted_peer_header_is_ignored() {
        let p = policy("x-forwarded-for", &["10.0.0.0/8"]);
        let h = headers("x-forwarded-for", &["6.6.6.6"]);
        assert_eq!(
            p.client_ip(sock("203.0.113.9:4000"), &h),
            "203.0.113.9".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn rightmost_untrusted_forwarded_entry_wins() {
        let p = policy("x-forwarded-for", &["10.0.0.0/8"]);
        // The visitor forged 6.6.6.6; the ingress appended the address it really saw.
        let h = headers("x-forwarded-for", &["6.6.6.6, 198.51.100.7", "10.0.0.3"]);
        assert_eq!(
            p.client_ip(sock("10.0.0.2:80"), &h),
            "198.51.100.7".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn forwarded_entries_with_ports_parse() {
        let p = policy("x-forwarded-for", &["10.0.0.0/8"]);
        let h = headers("x-forwarded-for", &["[2001:db8::5]:443"]);
        assert_eq!(
            p.client_ip(sock("10.0.0.2:80"), &h),
            "2001:db8::5".parse::<IpAddr>().unwrap()
        );
        let h = headers("x-forwarded-for", &["198.51.100.1:1234"]);
        assert_eq!(
            p.client_ip(sock("10.0.0.2:80"), &h),
            "198.51.100.1".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn all_trusted_chain_gives_leftmost() {
        let p = policy("x-forwarded-for", &["10.0.0.0/8", "192.168.0.0/16"]);
        let h = headers("x-forwarded-for", &["192.168.1.20, 10.0.0.3"]);
        assert_eq!(
            p.client_ip(sock("10.0.0.2:80"), &h),
            "192.168.1.20".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn missing_header_falls_back_to_peer() {
        let p = policy("x-real-ip", &["10.0.0.0/8"]);
        assert_eq!(
            p.client_ip(sock("10.0.0.2:80"), &HeaderMap::new()),
            "10.0.0.2".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn network_rooms_group_by_prefix() {
        let a = network_room_key("2001:db8:1:2::10".parse().unwrap(), 32, 64);
        let b = network_room_key("2001:db8:1:2:ffff::1".parse().unwrap(), 32, 64);
        let c = network_room_key("2001:db8:1:3::10".parse().unwrap(), 32, 64);
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(
            network_room_key("203.0.113.5".parse().unwrap(), 32, 64),
            "net:203.0.113.5/32"
        );
        assert_eq!(
            network_room_key("::ffff:192.168.4.7".parse().unwrap(), 24, 64),
            "net:192.168.4.0/24"
        );
    }
}
