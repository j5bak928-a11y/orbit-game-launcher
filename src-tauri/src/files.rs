use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

/// Bound reads using the opened file, even if its size changes after metadata is read.
/// Callers that reject links or require directory containment must check those separately.
pub(crate) fn read_regular_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let check = |metadata: fs::Metadata| {
        if !metadata.is_file() || metadata.len() > limit {
            return Err("File is not a regular file within the size limit.".to_string());
        }
        Ok(())
    };
    check(fs::metadata(path).map_err(|e| e.to_string())?)?;
    let file = File::open(path).map_err(|e| e.to_string())?;
    check(file.metadata().map_err(|e| e.to_string())?)?;
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("File exceeds the safe size limit.".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_read_accepts_the_limit_and_rejects_larger_files_and_directories() {
        let dir = std::env::temp_dir().join(format!("orbit-bounded-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("manifest.json");
        fs::write(&path, b"1234").unwrap();
        let at_limit = read_regular_bounded(&path, 4);
        let over_limit = read_regular_bounded(&path, 3);
        let directory = read_regular_bounded(&dir, 4);
        fs::remove_dir_all(dir).unwrap();

        assert_eq!(at_limit.unwrap(), b"1234");
        assert!(over_limit.is_err());
        assert!(directory.is_err());
    }
}
