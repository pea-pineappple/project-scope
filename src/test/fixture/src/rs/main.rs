mod cli;
mod net;

use crate::cli::args as cliargs;
use crate::net::parse::parse;

fn main() {
    let a = cliargs::parse("x");
    let n = parse(a);
    println!("{}", n);
}
