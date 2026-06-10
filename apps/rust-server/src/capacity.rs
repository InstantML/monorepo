use serde::Serialize;

use crate::{
    control_db::{control_db_max_connections_from_lookup, DEFAULT_CONTROL_DB_MAX_CONNECTIONS},
    errors::{AppError, AppResult},
};

const DEFAULT_ACTIVE_REVISIONS: u32 = 1;
const DEFAULT_ACTIVE_INSTANCES_PER_REVISION: u32 = 2;
const DEFAULT_OPERATOR_JOB_CONNECTIONS: u32 = 2;
const DEFAULT_MIGRATION_JOB_CONNECTIONS: u32 = 0;
const DEFAULT_RESERVED_HEADROOM_PERCENT: u8 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ControlDbConnectionBudgetInput {
    pub active_revisions: u32,
    pub active_instances_per_revision: u32,
    pub per_instance_pool_size: u32,
    pub deploy_overlap_connections: u32,
    pub operator_job_connections: u32,
    pub migration_job_connections: u32,
    pub connection_limit: Option<u32>,
    pub reserved_headroom_percent: u8,
}

impl Default for ControlDbConnectionBudgetInput {
    fn default() -> Self {
        Self {
            active_revisions: DEFAULT_ACTIVE_REVISIONS,
            active_instances_per_revision: DEFAULT_ACTIVE_INSTANCES_PER_REVISION,
            per_instance_pool_size: DEFAULT_CONTROL_DB_MAX_CONNECTIONS,
            deploy_overlap_connections: DEFAULT_CONTROL_DB_MAX_CONNECTIONS,
            operator_job_connections: DEFAULT_OPERATOR_JOB_CONNECTIONS,
            migration_job_connections: DEFAULT_MIGRATION_JOB_CONNECTIONS,
            connection_limit: None,
            reserved_headroom_percent: DEFAULT_RESERVED_HEADROOM_PERCENT,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetStatus {
    Ok,
    UnknownLimit,
    OverBudget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ControlDbConnectionBudgetReport {
    pub active_revisions: u32,
    pub active_instances_per_revision: u32,
    pub per_instance_pool_size: u32,
    pub deploy_overlap_connections: u32,
    pub operator_job_connections: u32,
    pub migration_job_connections: u32,
    pub projected_connections: u64,
    pub connection_limit: Option<u32>,
    pub reserved_headroom_percent: u8,
    pub usable_connections_after_headroom: Option<u64>,
    pub status: BudgetStatus,
    pub message: String,
}

impl ControlDbConnectionBudgetReport {
    pub fn is_over_budget(&self) -> bool {
        self.status == BudgetStatus::OverBudget
    }

    pub fn is_unknown_limit(&self) -> bool {
        self.status == BudgetStatus::UnknownLimit
    }
}

pub fn evaluate_control_db_connection_budget(
    input: ControlDbConnectionBudgetInput,
) -> AppResult<ControlDbConnectionBudgetReport> {
    let projected_connections = checked_projected_connections(input)?;
    let usable_connections_after_headroom = input.connection_limit.map(|limit| {
        let usable_percent = 100_u64.saturating_sub(u64::from(input.reserved_headroom_percent));
        (u64::from(limit) * usable_percent) / 100
    });
    let (status, message) = match usable_connections_after_headroom {
        Some(usable) if projected_connections <= usable => (
            BudgetStatus::Ok,
            format!(
                "projected {projected_connections} Cloud SQL connections fit within {usable} usable connections after headroom"
            ),
        ),
        Some(usable) => (
            BudgetStatus::OverBudget,
            format!(
                "projected {projected_connections} Cloud SQL connections exceed {usable} usable connections after headroom"
            ),
        ),
        None => (
            BudgetStatus::UnknownLimit,
            "set INSTANTML_CLOUD_SQL_CONNECTION_LIMIT to enforce this budget".to_string(),
        ),
    };
    Ok(ControlDbConnectionBudgetReport {
        active_revisions: input.active_revisions,
        active_instances_per_revision: input.active_instances_per_revision,
        per_instance_pool_size: input.per_instance_pool_size,
        deploy_overlap_connections: input.deploy_overlap_connections,
        operator_job_connections: input.operator_job_connections,
        migration_job_connections: input.migration_job_connections,
        projected_connections,
        connection_limit: input.connection_limit,
        reserved_headroom_percent: input.reserved_headroom_percent,
        usable_connections_after_headroom,
        status,
        message,
    })
}

fn checked_projected_connections(input: ControlDbConnectionBudgetInput) -> AppResult<u64> {
    let pooled_service_connections = u64::from(input.active_revisions)
        .checked_mul(u64::from(input.active_instances_per_revision))
        .and_then(|value| value.checked_mul(u64::from(input.per_instance_pool_size)))
        .ok_or_else(capacity_projection_overflow)?;
    [
        pooled_service_connections,
        u64::from(input.deploy_overlap_connections),
        u64::from(input.operator_job_connections),
        u64::from(input.migration_job_connections),
    ]
    .into_iter()
    .try_fold(0_u64, |total, value| {
        total
            .checked_add(value)
            .ok_or_else(capacity_projection_overflow)
    })
}

fn capacity_projection_overflow() -> AppError {
    AppError::config(
        "capacity connection projection overflowed; lower the capacity inputs to operationally plausible values",
    )
}

pub fn control_db_connection_budget_from_env() -> AppResult<ControlDbConnectionBudgetInput> {
    control_db_connection_budget_from_lookup(|key| std::env::var(key).ok())
}

fn control_db_connection_budget_from_lookup<F>(
    lookup: F,
) -> AppResult<ControlDbConnectionBudgetInput>
where
    F: Fn(&str) -> Option<String>,
{
    let per_instance_pool_size = control_db_max_connections_from_lookup(&lookup)?;
    Ok(ControlDbConnectionBudgetInput {
        active_revisions: env_u32(
            &lookup,
            "INSTANTML_CAPACITY_ACTIVE_REVISIONS",
            DEFAULT_ACTIVE_REVISIONS,
            true,
        )?,
        active_instances_per_revision: env_u32(
            &lookup,
            "INSTANTML_CAPACITY_ACTIVE_INSTANCES",
            DEFAULT_ACTIVE_INSTANCES_PER_REVISION,
            true,
        )?,
        per_instance_pool_size,
        deploy_overlap_connections: env_u32(
            &lookup,
            "INSTANTML_CAPACITY_DEPLOY_OVERLAP_CONNECTIONS",
            per_instance_pool_size,
            false,
        )?,
        operator_job_connections: env_u32(
            &lookup,
            "INSTANTML_CAPACITY_OPERATOR_JOB_CONNECTIONS",
            DEFAULT_OPERATOR_JOB_CONNECTIONS,
            false,
        )?,
        migration_job_connections: env_u32(
            &lookup,
            "INSTANTML_CAPACITY_MIGRATION_JOB_CONNECTIONS",
            DEFAULT_MIGRATION_JOB_CONNECTIONS,
            false,
        )?,
        connection_limit: env_optional_u32(&lookup, "INSTANTML_CLOUD_SQL_CONNECTION_LIMIT")?,
        reserved_headroom_percent: env_headroom_percent(&lookup)?,
    })
}

fn env_u32<F>(lookup: &F, key: &str, fallback: u32, nonzero: bool) -> AppResult<u32>
where
    F: Fn(&str) -> Option<String>,
{
    let Some(raw) = lookup(key) else {
        return Ok(fallback);
    };
    let value = parse_u32(key, &raw)?;
    if nonzero && value == 0 {
        return Err(AppError::config(format!("{key} must be greater than zero")));
    }
    Ok(value)
}

fn env_optional_u32<F>(lookup: &F, key: &str) -> AppResult<Option<u32>>
where
    F: Fn(&str) -> Option<String>,
{
    lookup(key)
        .map(|raw| {
            let value = parse_u32(key, &raw)?;
            if value == 0 {
                return Err(AppError::config(format!("{key} must be greater than zero")));
            }
            Ok(value)
        })
        .transpose()
}

fn env_headroom_percent<F>(lookup: &F) -> AppResult<u8>
where
    F: Fn(&str) -> Option<String>,
{
    let Some(raw) = lookup("INSTANTML_CAPACITY_RESERVED_HEADROOM_PERCENT") else {
        return Ok(DEFAULT_RESERVED_HEADROOM_PERCENT);
    };
    let value = parse_u32("INSTANTML_CAPACITY_RESERVED_HEADROOM_PERCENT", &raw)?;
    if value >= 100 {
        return Err(AppError::config(
            "INSTANTML_CAPACITY_RESERVED_HEADROOM_PERCENT must be less than 100",
        ));
    }
    Ok(value as u8)
}

fn parse_u32(key: &str, raw: &str) -> AppResult<u32> {
    raw.trim()
        .parse::<u32>()
        .map_err(|_| AppError::config(format!("{key} must be an unsigned integer")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn evaluates_budget_with_reserved_headroom() {
        let report = evaluate_control_db_connection_budget(ControlDbConnectionBudgetInput {
            active_revisions: 2,
            active_instances_per_revision: 3,
            per_instance_pool_size: 5,
            deploy_overlap_connections: 4,
            operator_job_connections: 2,
            migration_job_connections: 1,
            connection_limit: Some(50),
            reserved_headroom_percent: 20,
        })
        .expect("budget should evaluate");
        assert_eq!(report.projected_connections, 37);
        assert_eq!(report.usable_connections_after_headroom, Some(40));
        assert_eq!(report.status, BudgetStatus::Ok);
    }

    #[test]
    fn flags_over_budget_when_projection_exceeds_headroom() {
        let report = evaluate_control_db_connection_budget(ControlDbConnectionBudgetInput {
            active_revisions: 2,
            active_instances_per_revision: 3,
            per_instance_pool_size: 5,
            deploy_overlap_connections: 4,
            operator_job_connections: 2,
            migration_job_connections: 1,
            connection_limit: Some(40),
            reserved_headroom_percent: 20,
        })
        .expect("budget should evaluate");
        assert_eq!(report.projected_connections, 37);
        assert_eq!(report.usable_connections_after_headroom, Some(32));
        assert_eq!(report.status, BudgetStatus::OverBudget);
        assert!(report.is_over_budget());
    }

    #[test]
    fn reports_unknown_limit_without_failing_budget_math() {
        let report = evaluate_control_db_connection_budget(ControlDbConnectionBudgetInput {
            connection_limit: None,
            ..ControlDbConnectionBudgetInput::default()
        })
        .expect("budget should evaluate");
        assert_eq!(report.status, BudgetStatus::UnknownLimit);
        assert_eq!(report.usable_connections_after_headroom, None);
    }

    #[test]
    fn rejects_projection_overflow() {
        let err = evaluate_control_db_connection_budget(ControlDbConnectionBudgetInput {
            active_revisions: u32::MAX,
            active_instances_per_revision: u32::MAX,
            per_instance_pool_size: u32::MAX,
            deploy_overlap_connections: u32::MAX,
            operator_job_connections: u32::MAX,
            migration_job_connections: u32::MAX,
            connection_limit: Some(u32::MAX),
            reserved_headroom_percent: 20,
        })
        .expect_err("overflow should fail");
        assert!(err.message().contains("overflowed"));
    }

    #[test]
    fn parses_capacity_inputs_from_lookup() {
        let env = BTreeMap::from([
            ("INSTANTML_CAPACITY_ACTIVE_REVISIONS", "2"),
            ("INSTANTML_CAPACITY_ACTIVE_INSTANCES", "4"),
            ("CONTROL_DB_MAX_CONNECTIONS", "6"),
            ("INSTANTML_CAPACITY_DEPLOY_OVERLAP_CONNECTIONS", "8"),
            ("INSTANTML_CAPACITY_OPERATOR_JOB_CONNECTIONS", "3"),
            ("INSTANTML_CAPACITY_MIGRATION_JOB_CONNECTIONS", "2"),
            ("INSTANTML_CLOUD_SQL_CONNECTION_LIMIT", "100"),
            ("INSTANTML_CAPACITY_RESERVED_HEADROOM_PERCENT", "25"),
        ]);
        let input = control_db_connection_budget_from_lookup(|key| {
            env.get(key).map(|value| (*value).to_string())
        })
        .expect("capacity input should parse");
        assert_eq!(
            input,
            ControlDbConnectionBudgetInput {
                active_revisions: 2,
                active_instances_per_revision: 4,
                per_instance_pool_size: 6,
                deploy_overlap_connections: 8,
                operator_job_connections: 3,
                migration_job_connections: 2,
                connection_limit: Some(100),
                reserved_headroom_percent: 25,
            }
        );
    }

    #[test]
    fn rejects_invalid_capacity_inputs() {
        let env = BTreeMap::from([("INSTANTML_CAPACITY_ACTIVE_INSTANCES", "0")]);
        let err = control_db_connection_budget_from_lookup(|key| {
            env.get(key).map(|value| (*value).to_string())
        })
        .expect_err("zero active instances should fail");
        assert!(err.message().contains("greater than zero"));

        let env = BTreeMap::from([("INSTANTML_CAPACITY_RESERVED_HEADROOM_PERCENT", "100")]);
        let err = control_db_connection_budget_from_lookup(|key| {
            env.get(key).map(|value| (*value).to_string())
        })
        .expect_err("100 percent headroom should fail");
        assert!(err.message().contains("less than 100"));
    }
}
