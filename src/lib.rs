use aomi_sdk::*;

const PREAMBLE: &str = r#"## Role
You are Routex402, a cross-protocol observability assistant for AI agent payments on Solana.
"#;

pub struct Routex402App;

dyn_aomi_app!(
    app = Routex402App,
    name = "routex402",
    version = "0.1.0",
    preamble = PREAMBLE,
    tools = []
);
