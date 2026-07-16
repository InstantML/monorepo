use super::*;
use regex::{Regex, RegexBuilder};

const MAX_RUN_SEARCH_QUERY_BYTES: usize = 512;
const MAX_RUN_SEARCH_TERMS: usize = 32;
const MAX_RUN_SEARCH_AST_NODES: usize = 64;
const MAX_RUN_SEARCH_DEPTH: usize = 8;
const MAX_RUN_SEARCH_REGEXES: usize = 4;
const MAX_RUN_SEARCH_REGEX_BYTES: usize = 128;

#[derive(Clone, Debug)]
pub(super) struct CompiledRunSearch {
    expr: Option<SearchExpr>,
    uses_regex: bool,
    advanced: bool,
}

#[derive(Clone, Debug)]
enum SearchExpr {
    Predicate(SearchPredicate),
    Not(Box<SearchExpr>),
    And(Vec<SearchExpr>),
    Or(Vec<SearchExpr>),
}

#[derive(Clone, Debug)]
struct SearchPredicate {
    field: SearchField,
    matcher: SearchMatcher,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SearchField {
    All,
    Name,
    Project,
    Notes,
    Config,
    Metadata,
    Tag,
    Status,
    Id,
}

#[derive(Clone, Debug)]
enum SearchMatcher {
    Literal(String),
    LiteralAny(Vec<String>),
    Regex(Regex),
}

#[derive(Clone, Debug)]
enum SearchToken {
    Predicate(SearchPredicate),
    LParen,
    RParen,
    And,
    Or,
    Not,
}

#[derive(Debug)]
enum SearchIssueKind {
    Incomplete,
    Invalid(&'static str),
}

#[derive(Debug)]
struct SearchIssue {
    kind: SearchIssueKind,
    column: usize,
}

impl CompiledRunSearch {
    pub(super) fn empty() -> Self {
        Self {
            expr: None,
            uses_regex: false,
            advanced: false,
        }
    }

    pub(super) fn is_empty(&self) -> bool {
        self.expr.is_none()
    }

    pub(super) fn is_simple_literal_and(&self) -> bool {
        !self.advanced && !self.uses_regex
    }

    pub(super) fn matches(&self, doc: &RunSearchDocument) -> bool {
        self.expr
            .as_ref()
            .map(|expr| expr_matches(expr, doc))
            .unwrap_or(true)
    }
}

pub(super) fn compile_run_search(raw: Option<&str>) -> AppResult<CompiledRunSearch> {
    let raw = raw.unwrap_or("").trim();
    if raw.is_empty() {
        return Ok(CompiledRunSearch::empty());
    }
    if raw.len() > MAX_RUN_SEARCH_QUERY_BYTES {
        return Err(AppError::search_validation(
            "Run search is too long.",
            Some(1),
        ));
    }
    match tokenize(raw) {
        Ok(tokens) => compile_tokens(raw, tokens),
        Err(issue) => match issue.kind {
            SearchIssueKind::Incomplete => Ok(legacy_literal_search(raw)),
            SearchIssueKind::Invalid(message) => Err(AppError::search_validation(
                format!("Invalid run search: {message} at column {}.", issue.column),
                Some(issue.column),
            )),
        },
    }
}

pub(super) fn run_matches_search(
    data: &StoreData,
    run: &RunRow,
    search: &CompiledRunSearch,
) -> bool {
    if search.is_empty() {
        return true;
    }
    if let Some(doc) = data.run_search_documents.get(&run.id) {
        // Match against the cached document in place when the display status
        // already agrees with the stored one (the common case). The
        // unconditional clone copied a potentially config/metadata-sized
        // document for every run in the org on each filtered query, under the
        // store lock.
        let display_status = run_control_display_status(run, run_control_for(data, run));
        if doc.status == display_status {
            return search.matches(doc.as_ref());
        }
        let mut doc = doc.as_ref().clone();
        apply_display_status_to_search_document(data, run, &mut doc);
        return search.matches(&doc);
    }
    let mut doc = run_search_document(run);
    apply_display_status_to_search_document(data, run, &mut doc);
    search.matches(&doc)
}

fn apply_display_status_to_search_document(
    data: &StoreData,
    run: &RunRow,
    doc: &mut RunSearchDocument,
) {
    let display_status = run_control_display_status(run, run_control_for(data, run));
    if doc.status == display_status {
        return;
    }
    doc.status = display_status.to_string();
    doc.summary.push(' ');
    doc.summary.push_str(display_status);
}

fn compile_tokens(raw: &str, tokens: Vec<SearchToken>) -> AppResult<CompiledRunSearch> {
    let advanced = tokens.iter().any(|token| {
        matches!(
            token,
            SearchToken::LParen
                | SearchToken::RParen
                | SearchToken::And
                | SearchToken::Or
                | SearchToken::Not
        )
    }) || tokens.iter().any(|token| match token {
        SearchToken::Predicate(predicate) => predicate.field != SearchField::All,
        _ => false,
    });
    let uses_regex = tokens.iter().any(|token| match token {
        SearchToken::Predicate(predicate) => matches!(predicate.matcher, SearchMatcher::Regex(_)),
        _ => false,
    });
    let regex_count = tokens
        .iter()
        .filter(|token| {
            matches!(
                token,
                SearchToken::Predicate(SearchPredicate {
                    matcher: SearchMatcher::Regex(_),
                    ..
                })
            )
        })
        .count();
    if regex_count > MAX_RUN_SEARCH_REGEXES {
        return Err(AppError::search_validation(
            "Invalid run search: too many regex terms.",
            Some(1),
        ));
    }
    let mut parser = Parser {
        tokens: &tokens,
        index: 0,
    };
    let expr = match parser.parse_or(0) {
        Ok(expr) if parser.index == tokens.len() => expr,
        Ok(_) => return Ok(legacy_literal_search(raw)),
        Err(issue) => match issue.kind {
            SearchIssueKind::Incomplete => return Ok(legacy_literal_search(raw)),
            SearchIssueKind::Invalid(message) => {
                return Err(AppError::search_validation(
                    format!("Invalid run search: {message} at column {}.", issue.column),
                    Some(issue.column),
                ));
            }
        },
    };
    let term_count = count_predicates(&expr);
    if term_count > MAX_RUN_SEARCH_TERMS {
        return Err(AppError::search_validation(
            "Invalid run search: too many search terms.",
            Some(1),
        ));
    }
    if count_nodes(&expr) > MAX_RUN_SEARCH_AST_NODES {
        return Err(AppError::search_validation(
            "Invalid run search: query is too complex.",
            Some(1),
        ));
    }
    Ok(CompiledRunSearch {
        expr: Some(expr),
        uses_regex,
        advanced,
    })
}

fn legacy_literal_search(raw: &str) -> CompiledRunSearch {
    let simple_tokens = raw
        .split_whitespace()
        .map(|part| part.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let expr = SearchExpr::And(
        simple_tokens
            .iter()
            .cloned()
            .map(|token| {
                SearchExpr::Predicate(SearchPredicate {
                    field: SearchField::All,
                    matcher: SearchMatcher::Literal(token),
                })
            })
            .collect(),
    );
    CompiledRunSearch {
        expr: Some(expr),
        uses_regex: false,
        advanced: false,
    }
}

fn tokenize(raw: &str) -> Result<Vec<SearchToken>, SearchIssue> {
    let mut tokens = Vec::new();
    let mut index = 0;
    let mut regex_count = 0;
    while index < raw.len() {
        let Some(ch) = raw[index..].chars().next() else {
            break;
        };
        if ch.is_whitespace() {
            index += ch.len_utf8();
            continue;
        }
        let column = char_column(raw, index);
        match ch {
            '(' => {
                tokens.push(SearchToken::LParen);
                index += 1;
            }
            ')' => {
                tokens.push(SearchToken::RParen);
                index += 1;
            }
            '-' if minus_is_not_operator(raw, index) => {
                tokens.push(SearchToken::Not);
                index += 1;
            }
            '"' => {
                let (value, next) = parse_quoted(raw, index)?;
                tokens.push(SearchToken::Predicate(quoted_predicate(
                    SearchField::All,
                    &value,
                    column,
                )?));
                index = next;
            }
            _ => {
                if let Some((field, prefix_len)) = field_prefix(&raw[index..]) {
                    let value_start = index + prefix_len;
                    if value_start >= raw.len() {
                        return Err(incomplete(column));
                    }
                    if raw[value_start..].starts_with("re:/") {
                        if field == SearchField::Id {
                            return Err(invalid("regex is not supported for id search", column));
                        }
                        let (pattern, next) = parse_regex(raw, value_start + "re:/".len())?;
                        regex_count += 1;
                        tokens.push(SearchToken::Predicate(regex_predicate(
                            field, &pattern, column,
                        )?));
                        index = next;
                    } else if raw[value_start..].starts_with('"') {
                        let (value, next) = parse_quoted(raw, value_start)?;
                        tokens.push(SearchToken::Predicate(quoted_predicate(
                            field, &value, column,
                        )?));
                        index = next;
                    } else if raw[value_start..].starts_with('(') {
                        return Err(incomplete(column));
                    } else {
                        let next = scan_word_end(raw, value_start);
                        let value = &raw[value_start..next];
                        if value.is_empty() {
                            return Err(incomplete(column));
                        }
                        tokens.push(SearchToken::Predicate(field_predicate(
                            field, value, column,
                        )?));
                        index = next;
                    }
                } else if raw[index..].starts_with("re:/") {
                    let (pattern, next) = parse_regex(raw, index + "re:/".len())?;
                    regex_count += 1;
                    tokens.push(SearchToken::Predicate(regex_predicate(
                        SearchField::All,
                        &pattern,
                        column,
                    )?));
                    index = next;
                } else {
                    let next = scan_word_end(raw, index);
                    let word = &raw[index..next];
                    match word {
                        "AND" => tokens.push(SearchToken::And),
                        "OR" => tokens.push(SearchToken::Or),
                        "NOT" => tokens.push(SearchToken::Not),
                        _ => tokens.push(SearchToken::Predicate(literal_predicate(
                            SearchField::All,
                            word,
                        ))),
                    }
                    index = next;
                }
            }
        }
        if regex_count > MAX_RUN_SEARCH_REGEXES {
            return Err(invalid("too many regex terms", column));
        }
    }
    if tokens.is_empty() {
        return Err(incomplete(1));
    }
    Ok(tokens)
}

fn minus_is_not_operator(raw: &str, index: usize) -> bool {
    let next = index + 1;
    if next >= raw.len() {
        return false;
    }
    let tail = &raw[next..];
    tail.starts_with('(') || tail.starts_with("re:/") || field_prefix(tail).is_some()
}

fn field_prefix(raw: &str) -> Option<(SearchField, usize)> {
    for (name, field) in [
        ("metadata", SearchField::Metadata),
        ("project", SearchField::Project),
        ("config", SearchField::Config),
        ("status", SearchField::Status),
        ("notes", SearchField::Notes),
        ("name", SearchField::Name),
        ("tags", SearchField::Tag),
        ("tag", SearchField::Tag),
        ("all", SearchField::All),
        ("id", SearchField::Id),
    ] {
        let prefix = format!("{name}:");
        if raw.starts_with(&prefix) {
            return Some((field, prefix.len()));
        }
    }
    None
}

fn field_predicate(
    field: SearchField,
    value: &str,
    column: usize,
) -> Result<SearchPredicate, SearchIssue> {
    let value = value.trim();
    if value.is_empty() {
        return Err(incomplete(column));
    }
    if field == SearchField::Status
        && !matches!(
            value.to_ascii_lowercase().as_str(),
            "running" | "stopping" | "stopped" | "finished" | "failed"
        )
    {
        return Err(invalid(
            "status must be running, stopping, stopped, finished, or failed",
            column,
        ));
    }
    if field == SearchField::Id && value.len() < 4 {
        return Err(incomplete(column));
    }
    Ok(literal_predicate(field, value))
}

fn quoted_predicate(
    field: SearchField,
    value: &str,
    column: usize,
) -> Result<SearchPredicate, SearchIssue> {
    if value.trim().is_empty() {
        return Err(invalid("quoted phrase must not be empty", column));
    }
    field_predicate(field, value, column)
}

fn literal_predicate(field: SearchField, value: &str) -> SearchPredicate {
    SearchPredicate {
        field,
        matcher: SearchMatcher::Literal(value.to_ascii_lowercase()),
    }
}

fn regex_predicate(
    field: SearchField,
    pattern: &str,
    column: usize,
) -> Result<SearchPredicate, SearchIssue> {
    if pattern.is_empty() {
        return Err(incomplete(column));
    }
    if pattern.len() > MAX_RUN_SEARCH_REGEX_BYTES {
        return Err(invalid("regex pattern is too long", column));
    }
    if let Some(values) = simple_literal_alternatives(pattern) {
        return Ok(SearchPredicate {
            field,
            matcher: SearchMatcher::LiteralAny(values),
        });
    }
    let regex = RegexBuilder::new(pattern)
        .case_insensitive(true)
        .build()
        .map_err(|_| invalid("regex is invalid", column))?;
    if regex.is_match("") {
        return Err(invalid("regex must not match empty text", column));
    }
    Ok(SearchPredicate {
        field,
        matcher: SearchMatcher::Regex(regex),
    })
}

fn parse_quoted(raw: &str, start: usize) -> Result<(String, usize), SearchIssue> {
    let mut value = String::new();
    let mut index = start + 1;
    while index < raw.len() {
        let ch = raw[index..].chars().next().unwrap();
        if ch == '"' {
            return Ok((value, index + 1));
        }
        if ch == '\\' {
            let next_index = index + 1;
            if next_index >= raw.len() {
                return Err(incomplete(char_column(raw, start)));
            }
            let next = raw[next_index..].chars().next().unwrap();
            if next == '"' || next == '\\' {
                value.push(next);
                index = next_index + next.len_utf8();
                continue;
            }
            value.push(ch);
            index += ch.len_utf8();
            continue;
        }
        value.push(ch);
        index += ch.len_utf8();
    }
    Err(incomplete(char_column(raw, start)))
}

fn parse_regex(raw: &str, start: usize) -> Result<(String, usize), SearchIssue> {
    let mut pattern = String::new();
    let mut index = start;
    while index < raw.len() {
        let ch = raw[index..].chars().next().unwrap();
        if ch == '/' {
            return Ok((pattern, index + 1));
        }
        if ch == '\\' {
            let next_index = index + 1;
            if next_index >= raw.len() {
                return Err(incomplete(char_column(raw, start)));
            }
            let next = raw[next_index..].chars().next().unwrap();
            if next == '/' {
                pattern.push('/');
            } else {
                pattern.push(ch);
                pattern.push(next);
            }
            index = next_index + next.len_utf8();
            continue;
        }
        pattern.push(ch);
        index += ch.len_utf8();
    }
    Err(incomplete(char_column(raw, start)))
}

fn scan_word_end(raw: &str, start: usize) -> usize {
    let mut index = start;
    while index < raw.len() {
        let ch = raw[index..].chars().next().unwrap();
        if ch.is_whitespace() || ch == '(' || ch == ')' {
            break;
        }
        index += ch.len_utf8();
    }
    index
}

struct Parser<'a> {
    tokens: &'a [SearchToken],
    index: usize,
}

impl Parser<'_> {
    fn parse_or(&mut self, depth: usize) -> Result<SearchExpr, SearchIssue> {
        self.check_depth(depth)?;
        let mut items = vec![self.parse_and(depth + 1)?];
        while matches!(self.peek(), Some(SearchToken::Or)) {
            self.index += 1;
            items.push(self.parse_and(depth + 1)?);
        }
        Ok(if items.len() == 1 {
            items.remove(0)
        } else {
            SearchExpr::Or(items)
        })
    }

    fn parse_and(&mut self, depth: usize) -> Result<SearchExpr, SearchIssue> {
        self.check_depth(depth)?;
        let mut items = vec![self.parse_unary(depth + 1)?];
        loop {
            match self.peek() {
                Some(SearchToken::And) => {
                    self.index += 1;
                    items.push(self.parse_unary(depth + 1)?);
                }
                Some(SearchToken::Predicate(_))
                | Some(SearchToken::LParen)
                | Some(SearchToken::Not) => {
                    items.push(self.parse_unary(depth + 1)?);
                }
                _ => break,
            }
        }
        Ok(if items.len() == 1 {
            items.remove(0)
        } else {
            SearchExpr::And(items)
        })
    }

    fn parse_unary(&mut self, depth: usize) -> Result<SearchExpr, SearchIssue> {
        self.check_depth(depth)?;
        if matches!(self.peek(), Some(SearchToken::Not)) {
            self.index += 1;
            return Ok(SearchExpr::Not(Box::new(self.parse_unary(depth + 1)?)));
        }
        self.parse_primary(depth + 1)
    }

    fn parse_primary(&mut self, depth: usize) -> Result<SearchExpr, SearchIssue> {
        self.check_depth(depth)?;
        match self.peek() {
            Some(SearchToken::Predicate(predicate)) => {
                let predicate = predicate.clone();
                self.index += 1;
                Ok(SearchExpr::Predicate(predicate))
            }
            Some(SearchToken::LParen) => {
                self.index += 1;
                let expr = self.parse_or(depth + 1)?;
                if matches!(self.peek(), Some(SearchToken::RParen)) {
                    self.index += 1;
                    Ok(expr)
                } else {
                    Err(incomplete(1))
                }
            }
            _ => Err(incomplete(1)),
        }
    }

    fn peek(&self) -> Option<&SearchToken> {
        self.tokens.get(self.index)
    }

    fn check_depth(&self, depth: usize) -> Result<(), SearchIssue> {
        if depth > MAX_RUN_SEARCH_DEPTH {
            Err(invalid("query nesting is too deep", 1))
        } else {
            Ok(())
        }
    }
}

fn expr_matches(expr: &SearchExpr, doc: &RunSearchDocument) -> bool {
    match expr {
        SearchExpr::Predicate(predicate) => predicate_matches(predicate, doc),
        SearchExpr::Not(item) => !expr_matches(item, doc),
        SearchExpr::And(items) => items.iter().all(|item| expr_matches(item, doc)),
        SearchExpr::Or(items) => items.iter().any(|item| expr_matches(item, doc)),
    }
}

fn predicate_matches(predicate: &SearchPredicate, doc: &RunSearchDocument) -> bool {
    match (&predicate.field, &predicate.matcher) {
        (SearchField::All, SearchMatcher::Literal(value)) => {
            doc.summary.contains(value)
                || all_large_field_texts(doc)
                    .into_iter()
                    .any(|text| text.contains(value))
        }
        (SearchField::All, SearchMatcher::LiteralAny(values)) => values.iter().any(|value| {
            doc.summary.contains(value)
                || all_large_field_texts(doc)
                    .into_iter()
                    .any(|text| text.contains(value))
        }),
        (SearchField::All, SearchMatcher::Regex(regex)) => {
            regex.is_match(&doc.summary)
                || all_large_field_texts(doc)
                    .into_iter()
                    .any(|text| regex.is_match(text))
        }
        (SearchField::Tag, SearchMatcher::Literal(value)) => {
            doc.tags.iter().any(|tag| tag == value)
        }
        (SearchField::Status, SearchMatcher::Literal(value)) => doc.status == *value,
        (SearchField::Id, SearchMatcher::Literal(value)) => doc.id.starts_with(value),
        (SearchField::Tag, SearchMatcher::Regex(regex)) => {
            doc.tags.iter().any(|tag| regex.is_match(tag))
        }
        (SearchField::Tag, SearchMatcher::LiteralAny(values)) => doc
            .tags
            .iter()
            .any(|tag| values.iter().any(|value| tag.contains(value))),
        (_, SearchMatcher::Literal(value)) => field_text(predicate.field, doc).contains(value),
        (_, SearchMatcher::LiteralAny(values)) => values
            .iter()
            .any(|value| field_text(predicate.field, doc).contains(value)),
        (_, SearchMatcher::Regex(regex)) => regex.is_match(field_text(predicate.field, doc)),
    }
}

fn all_large_field_texts(doc: &RunSearchDocument) -> [&str; 2] {
    [doc.config.as_str(), doc.metadata.as_str()]
}

fn field_text(field: SearchField, doc: &RunSearchDocument) -> &str {
    match field {
        SearchField::All => "",
        SearchField::Name => &doc.name,
        SearchField::Project => &doc.project,
        SearchField::Notes => &doc.notes,
        SearchField::Config => &doc.config,
        SearchField::Metadata => &doc.metadata,
        SearchField::Tag => "",
        SearchField::Status => &doc.status,
        SearchField::Id => &doc.id,
    }
}

fn simple_literal_alternatives(pattern: &str) -> Option<Vec<String>> {
    let open = pattern.find('(')?;
    let close = pattern[open + 1..].find(')')? + open + 1;
    if pattern[close + 1..].contains('(') || pattern[close + 1..].contains(')') {
        return None;
    }
    let prefix = &pattern[..open];
    let alternatives = &pattern[open + 1..close];
    let suffix = &pattern[close + 1..];
    if prefix.is_empty() && suffix.is_empty() {
        return None;
    }
    if alternatives.is_empty() || alternatives.starts_with('|') || alternatives.ends_with('|') {
        return None;
    }
    if !regex_literal_fragment(prefix) || !regex_literal_fragment(suffix) {
        return None;
    }
    let mut values = Vec::new();
    for alternative in alternatives.split('|') {
        if alternative.is_empty() || !regex_literal_fragment(alternative) {
            return None;
        }
        values.push(format!("{prefix}{alternative}{suffix}").to_ascii_lowercase());
    }
    Some(values)
}

fn regex_literal_fragment(value: &str) -> bool {
    value.chars().all(|ch| {
        !matches!(
            ch,
            '.' | '^' | '$' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '\\'
        )
    })
}

fn count_predicates(expr: &SearchExpr) -> usize {
    match expr {
        SearchExpr::Predicate(_) => 1,
        SearchExpr::Not(item) => count_predicates(item),
        SearchExpr::And(items) | SearchExpr::Or(items) => items.iter().map(count_predicates).sum(),
    }
}

fn count_nodes(expr: &SearchExpr) -> usize {
    match expr {
        SearchExpr::Predicate(_) => 1,
        SearchExpr::Not(item) => 1 + count_nodes(item),
        SearchExpr::And(items) | SearchExpr::Or(items) => {
            1 + items.iter().map(count_nodes).sum::<usize>()
        }
    }
}

fn incomplete(column: usize) -> SearchIssue {
    SearchIssue {
        kind: SearchIssueKind::Incomplete,
        column,
    }
}

fn invalid(message: &'static str, column: usize) -> SearchIssue {
    SearchIssue {
        kind: SearchIssueKind::Invalid(message),
        column,
    }
}

fn char_column(raw: &str, byte_index: usize) -> usize {
    raw[..byte_index.min(raw.len())].chars().count() + 1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> RunSearchDocument {
        let run = RunRow {
            id: Uuid::parse_str("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").unwrap(),
            org_id: Uuid::from_u128(1),
            project_id: Uuid::from_u128(2),
            project: "cartpole".to_string(),
            name: "seed-13 long context".to_string(),
            status: "finished".to_string(),
            config: json!({"seed": 13, "model": "long context", "delta": -1, "label": "-loss"}),
            tags: vec!["baseline".to_string(), "ready for compare".to_string()],
            metadata: json!({"notes": "reward stability ablated", "summary": "fallback note"}),
            created_at: epoch(),
            started_at: epoch(),
            finished_at: Some(epoch()),
            parent_run_id: None,
            forked_from_step: None,
            forked_from_artifact_id: None,
            resume_count: 0,
            resumed_at: None,
            create_request_hash: None,
            lifecycle: Vec::new(),
        };
        run_search_document(&run)
    }

    #[test]
    fn bare_terms_preserve_legacy_and_semantics() {
        let search = compile_run_search(Some("seed 13")).unwrap();
        assert!(search.is_simple_literal_and());
        assert!(search.matches(&doc()));
        assert!(!compile_run_search(Some("seed missing"))
            .unwrap()
            .matches(&doc()));
    }

    #[test]
    fn fields_booleans_phrases_and_exclusion_match_runs() {
        assert!(compile_run_search(Some("tag:baseline status:finished"))
            .unwrap()
            .matches(&doc()));
        assert!(compile_run_search(Some("name:\"long context\" -tag:debug"))
            .unwrap()
            .matches(&doc()));
        assert!(
            compile_run_search(Some("(tag:baseline OR tag:candidate) notes:ablated"))
                .unwrap()
                .matches(&doc())
        );
        assert!(!compile_run_search(Some("tag:baseline NOT notes:ablated"))
            .unwrap()
            .matches(&doc()));
        assert!(compile_run_search(Some("id:aaaaaaaa"))
            .unwrap()
            .matches(&doc()));
    }

    #[test]
    fn non_regex_semantics_cover_common_fields_and_fallbacks() {
        for query in [
            "all:stability",
            "project:cartpole",
            "config:seed",
            "metadata:summary",
            "tags:baseline",
            "NOT tag:debug",
            "tag:debug OR tag:baseline",
            "\"long context\"",
            "-1",
            "-loss",
        ] {
            assert!(
                compile_run_search(Some(query)).unwrap().matches(&doc()),
                "{query} should match"
            );
        }
        for query in [
            "tag:debug AND tag:baseline",
            "project:other",
            "status:running",
            "tag:(baseline OR",
        ] {
            assert!(
                !compile_run_search(Some(query)).unwrap().matches(&doc()),
                "{query} should not match"
            );
        }
    }

    #[test]
    fn empty_quoted_search_is_validation_error() {
        assert!(compile_run_search(Some("\"\"")).is_err());
        assert!(compile_run_search(Some("NOT \"\"")).is_err());
        assert!(compile_run_search(Some("name:\"\"")).is_err());
    }

    #[test]
    fn explicit_regex_is_supported_and_bounded() {
        assert!(compile_run_search(Some("re:/seed-(13|14)/"))
            .unwrap()
            .matches(&doc()));
        assert!(compile_run_search(Some("name:re:/LONG.CONTEXT/"))
            .unwrap()
            .matches(&doc()));
        assert!(compile_run_search(Some("re:/[/")).is_err());
        assert!(compile_run_search(Some("re:/.*/")).is_err());
        assert!(compile_run_search(Some("id:re:/aaaa/")).is_err());
    }

    #[test]
    fn all_search_checks_fields_even_when_aggregate_is_truncated() {
        let run = RunRow {
            id: Uuid::parse_str("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").unwrap(),
            org_id: Uuid::from_u128(1),
            project_id: Uuid::from_u128(2),
            project: "cartpole".to_string(),
            name: "large-config".to_string(),
            status: "finished".to_string(),
            config: json!({ "payload": "x".repeat(70_000) }),
            tags: vec![],
            metadata: json!({ "notes": "tail-only-search-token" }),
            created_at: epoch(),
            started_at: epoch(),
            finished_at: Some(epoch()),
            parent_run_id: None,
            forked_from_step: None,
            forked_from_artifact_id: None,
            resume_count: 0,
            resumed_at: None,
            create_request_hash: None,
            lifecycle: Vec::new(),
        };
        let doc = run_search_document(&run);

        assert!(doc.config.len() <= 32 * 1024);
        assert!(compile_run_search(Some("tail-only-search-token"))
            .unwrap()
            .matches(&doc));
        assert!(compile_run_search(Some("re:/tail-only-search-token/"))
            .unwrap()
            .matches(&doc));
    }

    #[test]
    fn incomplete_or_unknown_constructs_fall_back_to_literal_search() {
        assert!(compile_run_search(Some("foo:bar"))
            .unwrap()
            .is_simple_literal_and());
        assert!(compile_run_search(Some("tag:"))
            .unwrap()
            .is_simple_literal_and());
        assert!(compile_run_search(Some("tag:(baseline OR"))
            .unwrap()
            .is_simple_literal_and());
        assert!(compile_run_search(Some("\"unterminated"))
            .unwrap()
            .is_simple_literal_and());
        assert!(compile_run_search(Some("re:/unterminated"))
            .unwrap()
            .is_simple_literal_and());
        assert!(compile_run_search(Some("NOT"))
            .unwrap()
            .is_simple_literal_and());
    }

    #[test]
    fn invalid_status_is_a_search_validation_error() {
        let err = compile_run_search(Some("status:unknown")).unwrap_err();
        assert_eq!(err.code(), Some("run_search_invalid"));
    }

    #[test]
    fn over_nested_queries_return_search_validation_errors() {
        let err = compile_run_search(Some("(((((((((tag:baseline)))))))))")).unwrap_err();
        assert_eq!(err.code(), Some("run_search_invalid"));
    }
}
