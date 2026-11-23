mod assets;
mod config;
mod proxy;

use bytes::Bytes;
use config::Config;
use http_body_util::{BodyExt, Full, combinators::BoxBody};
use hyper::{Request, Response, StatusCode, body::Incoming, header, service::service_fn};
use hyper_util::rt::TokioIo;
use std::sync::Arc;
use tokio::net::TcpListener;

pub type Body = BoxBody<Bytes, hyper::Error>;

pub fn full(code: StatusCode, content_type: &str, body: impl Into<Bytes>) -> Response<Body> {
    let mut r = Response::new(Full::new(body.into()).map_err(|never| match never {}).boxed());
    *r.status_mut() = code;
    r.headers_mut().insert(header::CONTENT_TYPE, content_type.parse().unwrap());
    r
}

async fn handle(cfg: Arc<Config>, req: Request<Incoming>) -> Result<Response<Body>, hyper::Error> {
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    if !cfg.host_ok(host) {
        return Ok(full(StatusCode::FORBIDDEN, "text/plain; charset=utf-8", "host no permitido"));
    }
    if req.method() == hyper::Method::GET {
        let url = req.uri().path().to_string();
        match assets::find(&cfg, &url) {
            assets::Found::Asset(a) => {
                let mut r = full(StatusCode::OK, a.content_type, a.body);
                r.headers_mut().insert(header::CACHE_CONTROL, a.cache.parse().unwrap());
                return Ok(r);
            }
            assets::Found::Missing => return Ok(full(StatusCode::NOT_FOUND, "text/plain", "")),
            assets::Found::NotMine => {}
        }
    }
    Ok(proxy::to_node(&cfg, req).await)
}

#[tokio::main]
async fn main() {
    let cfg = Arc::new(Config::load());
    let listener = TcpListener::bind(("127.0.0.1", cfg.port)).await.unwrap_or_else(|e| panic!("no puedo escuchar en el puerto {}: {e}", cfg.port));
    println!("NutrIA (Rust) en http://127.0.0.1:{}; lo que falta lo pasa a Node en el {}", cfg.port, cfg.node_port);
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        let cfg = cfg.clone();
        tokio::spawn(async move {
            let service = service_fn(move |req| handle(cfg.clone(), req));
            let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service).with_upgrades().await;
        });
    }
}
