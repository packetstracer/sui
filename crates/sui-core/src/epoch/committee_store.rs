// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

use parking_lot::RwLock;
use rocksdb::Options;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use sui_storage::default_db_options;
use sui_types::base_types::ObjectID;
use sui_types::committee::{Committee, EpochId};
use sui_types::error::{SuiError, SuiResult};
use typed_store::rocks::{DBMap, DBOptions, MetricConf};
use typed_store::traits::{TableSummary, TypedStoreDebug};

use typed_store::Map;
use typed_store_derive::DBMapUtils;

use sui_macros::nondeterministic;

pub struct CommitteeStore {
    tables: CommitteeStoreTables,
    cache: RwLock<HashMap<EpochId, Committee>>,
}

#[derive(DBMapUtils)]
pub struct CommitteeStoreTables {
    /// Map from each epoch ID to the committee information.
    #[default_options_override_fn = "committee_table_default_config"]
    committee_map: DBMap<EpochId, Committee>,
}

// These functions are used to initialize the DB tables
fn committee_table_default_config() -> DBOptions {
    default_db_options(None, None).1
}

impl CommitteeStore {
    pub fn new(path: PathBuf, genesis_committee: &Committee, db_options: Option<Options>) -> Self {
        let tables = CommitteeStoreTables::open_tables_read_write(
            path,
            MetricConf::default(),
            db_options,
            None,
        );
        let store = Self {
            tables,
            cache: RwLock::new(HashMap::new()),
        };
        if store.database_is_empty() {
            store
                .init_genesis_committee(genesis_committee.clone())
                .expect("Init genesis committee data must not fail");
        }
        store
    }

    pub fn new_for_testing(genesis_committee: &Committee) -> Self {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("DB_{:?}", nondeterministic!(ObjectID::random())));
        Self::new(path, genesis_committee, None)
    }

    pub fn init_genesis_committee(&self, genesis_committee: Committee) -> SuiResult {
        assert_eq!(genesis_committee.epoch, 0);
        self.tables.committee_map.insert(&0, &genesis_committee)?;
        self.cache.write().insert(0, genesis_committee);
        Ok(())
    }

    pub fn insert_new_committee(&self, new_committee: &Committee) -> SuiResult {
        if let Some(old_committee) = self.get_committee(&new_committee.epoch)? {
            // If somehow we already have this committee in the store, they must be the same.
            assert_eq!(&old_committee, new_committee);
        } else {
            self.tables
                .committee_map
                .insert(&new_committee.epoch, new_committee)?;
            self.cache
                .write()
                .insert(new_committee.epoch, new_committee.clone());
        }
        Ok(())
    }

    pub fn get_committee(&self, epoch_id: &EpochId) -> SuiResult<Option<Committee>> {
        if let Some(committee) = self.cache.read().get(epoch_id) {
            return Ok(Some(committee.clone())); // todo use Arc
        }
        let committee = self.tables.committee_map.get(epoch_id)?;
        if let Some(committee) = committee.as_ref() {
            self.cache.write().insert(*epoch_id, committee.clone()); // todo use Arc
        }
        Ok(committee)
    }

    // todo - make use of cache or remove this method
    pub fn get_latest_committee(&self) -> Committee {
        self.tables
            .committee_map
            .iter()
            .skip_to_last()
            .next()
            // unwrap safe because we guarantee there is at least a genesis epoch
            // when initializing the store.
            .unwrap()
            .1
    }
    /// Return the committee specified by `epoch`. If `epoch` is `None`, return the latest committee.
    // todo - make use of cache or remove this method
    pub fn get_or_latest_committee(&self, epoch: Option<EpochId>) -> SuiResult<Committee> {
        Ok(match epoch {
            Some(epoch) => self
                .get_committee(&epoch)?
                .ok_or(SuiError::MissingCommitteeAtEpoch(epoch))?,
            None => self.get_latest_committee(),
        })
    }

    pub fn checkpoint_db(&self, path: &Path) -> SuiResult {
        self.tables
            .committee_map
            .checkpoint_db(path)
            .map_err(SuiError::StorageError)
    }

    fn database_is_empty(&self) -> bool {
        self.tables.committee_map.iter().next().is_none()
    }
}
