//! Port of src/commands/args.js.
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

pub type Command = fn(&Args) -> Result<i32, String>;

pub const ALIASES: [(&str, &str); 33] = [
    ("informe", "report"),
    ("reporte", "reporter"),
    ("aprobar-chat", "approve-chat"),
    ("envios", "dispatches"),
    ("adjuntos", "attachments"),
    ("hecha", "done"),
    ("a-medias", "partial"),
    ("pregunta", "question"),
    ("comentario", "comment"),
    ("entregada", "delivered"),
    ("enviada", "sent"),
    ("respuesta", "reply"),
    ("cambios", "changes"),
    ("orquestador", "orchestrator"),
    ("despliegues", "deployments"),
    ("despliegue-update", "deployment-update"),
    ("arranque", "startup"),
    ("aviso-prueba", "push-test"),
    ("error-enviado", "error-sent"),
    ("seguimiento", "people"),
    ("persona-cuentas", "person-accounts"),
    ("ordenar-estado", "tidy-status"),
    ("ordenar-empieza", "tidy-start"),
    ("ordenar-fin", "tidy-end"),
    ("mensaje", "message"),
    ("contesta", "answer-message"),
    ("progreso", "progress"),
    ("contados", "counted"),
    ("pendiente", "refresh-request"),
    ("epics-jira", "jira-epics"),
    ("abrir", "open"),
    ("aprendizaje-leer", "learning-read"),
    ("causa", "cause"),
];

pub static ME: LazyLock<String> = LazyLock::new(|| todo!());

pub static MY_FIRST_NAME: LazyLock<Regex> = LazyLock::new(|| todo!());

pub struct Args {
    pub argv: Vec<String>,
}

impl Args {
    pub fn new(argv: Vec<String>) -> Args {
        Args { argv }
    }

    pub fn from_env() -> Args {
        let mut argv: Vec<String> = std::env::args().collect();
        if argv.is_empty() {
            argv.push("tower".to_string());
        }
        argv.insert(1, "board.js".to_string());
        Args { argv }
    }

    pub fn raw_cmd(&self) -> Option<&str> {
        self.argv.get(2).map(String::as_str)
    }

    pub fn cmd(&self) -> String {
        let raw = self.raw_cmd().unwrap_or("");
        alias(raw).unwrap_or(raw).to_string()
    }

    pub fn a(&self) -> Option<&str> {
        self.argv.get(3).map(String::as_str)
    }

    pub fn b(&self) -> Option<&str> {
        self.argv.get(4).map(String::as_str)
    }

    pub fn from(&self, index: usize) -> &[String] {
        self.argv.get(index..).unwrap_or(&[])
    }

    pub fn has(&self, flag: &str) -> bool {
        self.argv.iter().any(|x| x == flag)
    }

    pub fn rest(&self, from: usize) -> String {
        self.from(from).join(" ").trim().to_string()
    }

    pub fn option(&self, names: &[&str]) -> Option<String> {
        todo!()
    }

    pub fn without_options(&self) -> Vec<String> {
        todo!()
    }

    pub fn environment_option(&self) -> Result<String, String> {
        todo!()
    }
}

pub fn alias(name: &str) -> Option<&'static str> {
    ALIASES.iter().find(|(k, _)| *k == name).map(|(_, v)| *v)
}

pub fn key_list(text: &str) -> Vec<String> {
    todo!()
}

pub fn json(x: &Value) {
    todo!()
}

pub fn status(s: &str) -> String {
    todo!()
}

pub fn fail(text: &str) -> ! {
    use std::io::Write;
    let _ = std::io::stdout().flush();
    eprintln!("{text}");
    std::process::exit(1)
}
