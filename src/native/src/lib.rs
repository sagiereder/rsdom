use napi_derive::napi;

#[napi]
pub fn native_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub mod css_parser;
pub mod html_parser;
