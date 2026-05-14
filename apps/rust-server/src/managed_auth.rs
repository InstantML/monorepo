use crate::{errors::AppResult, AppError};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManagedAuthPrincipal {
    pub provider: String,
    pub provider_subject: String,
    pub email: String,
    pub email_verified: bool,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

pub trait ManagedAuthVerifier {
    fn verify_bearer(&self, token: &str) -> AppResult<ManagedAuthPrincipal>;
}

#[derive(Clone, Debug, Default)]
pub struct DisabledManagedAuth;

impl ManagedAuthVerifier for DisabledManagedAuth {
    fn verify_bearer(&self, _token: &str) -> AppResult<ManagedAuthPrincipal> {
        Err(AppError::unauthorized("managed auth is not configured"))
    }
}
