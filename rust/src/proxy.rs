use crate::{Body, config::Config, full};
use http_body_util::BodyExt;
use hyper::{Request, Response, StatusCode, body::Incoming, header};
use hyper_util::rt::TokioIo;
use tokio::net::TcpStream;

fn wants_upgrade(req: &Request<Incoming>) -> bool {
    req.headers().get(header::UPGRADE).is_some()
}

fn unavailable() -> Response<Body> {
    full(StatusCode::BAD_GATEWAY, "application/json", r#"{"error":"la parte en Node del tablero no responde"}"#)
}

pub async fn to_node(cfg: &Config, mut req: Request<Incoming>) -> Response<Body> {
    let Ok(stream) = TcpStream::connect(("127.0.0.1", cfg.node_port)).await else { return unavailable() };
    let Ok((mut sender, conn)) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await else { return unavailable() };
    tokio::spawn(conn.with_upgrades());
    let upgrade = wants_upgrade(&req);
    let client_side = upgrade.then(|| hyper::upgrade::on(&mut req));
    let (parts, body) = req.into_parts();
    let forwarded = Request::from_parts(parts, body);
    let Ok(mut resp) = sender.send_request(forwarded).await else { return unavailable() };
    if let Some(client_side) = client_side {
        if resp.status() == StatusCode::SWITCHING_PROTOCOLS {
            let node_side = hyper::upgrade::on(&mut resp);
            tokio::spawn(async move {
                if let (Ok(a), Ok(b)) = (client_side.await, node_side.await) {
                    let _ = tokio::io::copy_bidirectional(&mut TokioIo::new(a), &mut TokioIo::new(b)).await;
                }
            });
        }
    }
    resp.map(|b| b.boxed())
}
