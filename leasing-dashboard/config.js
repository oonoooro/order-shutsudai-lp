/*
 * 週次リーシングダッシュボード 設定ファイル
 *
 * データファイルは週ごとに差し替える前提のため、ファイル名に日付を含めない。
 * 対象週は dashboard_data.json の report_metadata.source_period を使う。
 * ブラウザ（window.DASHBOARD_CONFIG）と Node（require）の両方から読み込める。
 */
(function (root, factory) {
  var config = factory();
  if (typeof module === 'object' && module.exports) module.exports = config;
  else root.DASHBOARD_CONFIG = config;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  return {
    // index.html からの相対パス。日付をハードコードしない。
    dataFiles: {
      dashboardData: 'data/dashboard_data.json',
      propertyMaster: 'data/property_master.csv',
      validationReport: 'data/validation_report.csv'
    },

    display: {
      // 金額表示単位: 'yen'（円）または 'man'（万円）。入力データの金額は円とみなす。
      moneyUnit: 'man',
      rateDecimals: 1,
      nullLabel: 'データなし',
      invalidLabel: '数値不正',
      notJudgedLabel: '判定不可',
      provisionalLabel: '暫定',
      // AD / FR は元データ上の単位が仕様で定義されていないため、単位を付けずに表示する。
      adFrUnitNote: '元データ単位'
    },

    calc: {
      // 仕様 4章: 元データ値と計算値の差がこの値を超えたらアラート
      rateTolerance: 0.0001,
      // 元データの稼働率の表現。'fraction'（0.95）を仕様の前提とする。
      sourceRateUnit: 'fraction',
      // マスター未登録の Project # をポートフォリオ集計に含めるか
      includeUnlinkedInPortfolio: false,
      // 読取失敗ファイルがある場合、集計を「暫定」とする
      provisionalWhenFilesFailed: true
    },

    alerts: {
      // 前週比でこのポイント以上低下したら「稼働率低下」（0.01 = 1.0pt）
      occupancyDropThreshold: 0.01,
      // 最大空室日数がこの日数以上なら「長期空室」
      longVacancyDays: 90,
      // コメント中のこの語句で「申込取消」を検出する（仕様に専用列がないため）
      cancellationKeywords: ['申込取消', '申込キャンセル', '申込撤回', 'キャンセル', '取消'],
      // dashboard_data.json の alerts[].code をアラート区分に振り分ける正規表現
      codePatterns: {
        read_failure: 'UNAVAILABLE|READ_FAIL|FAILED|MISSING_SOURCE|NOT_FOUND',
        mismatch: 'MISMATCH|INCONSIST|DIFF|RECONCIL',
        duplicate: 'DUPLICATE',
        low_confidence: 'LOW_CONF',
        cancellation: 'CANCEL'
      }
    },

    // 稼働率帯フィルター（min 以上 max 未満。max:null は上限なし）
    occupancyBands: [
      { id: 'lt80', label: '80%未満', min: 0, max: 0.8 },
      { id: '80to90', label: '80%以上90%未満', min: 0.8, max: 0.9 },
      { id: '90to95', label: '90%以上95%未満', min: 0.9, max: 0.95 },
      { id: 'ge95', label: '95%以上', min: 0.95, max: null }
    ],

    // 列名のゆれを吸収する別名（先頭が正規名）。比較時は NFKC・空白除去・小文字化する。
    masterColumns: {
      project_number: ['project_number', 'Project #', 'project_no', 'project no', 'プロジェクト番号'],
      project_name: ['project_name', 'Project Name'],
      property_name_ja: ['property_name_ja', '日本語物件名', '物件名'],
      property_name_en: ['property_name_en', 'English Name'],
      spc: ['spc', 'SPC'],
      am: ['am', 'AM'],
      pm: ['pm', 'PM'],
      master_source: ['master_source']
    },
    validationReportColumns: {
      file_name: ['ファイル名', 'file_name'],
      target_property: ['対象物件', 'target_property', 'project_number'],
      result: ['処理結果', 'result', 'status'],
      extracted_count: ['抽出項目数', 'extracted_count'],
      unreadable_items: ['読取不能項目', 'unreadable_items'],
      duplicate_flag: ['重複の可能性', 'duplicate_flag'],
      numeric_mismatch_flag: ['数値不一致', 'numeric_mismatch_flag'],
      name_mismatch_flag: ['物件名不一致', 'name_mismatch_flag'],
      confidence: ['データ確度', 'confidence', 'data_confidence'],
      reason: ['要確認理由', 'reason']
    },
    // validation_report.csv の値の解釈
    validationReportValues: {
      success: ['正常', '成功', 'success', 'ok'],
      partial: ['一部', '部分', 'partial'],
      failed: ['読取失敗', '失敗', 'failed', 'error'],
      yes: ['あり', '有', 'yes', 'true', '1', '要確認'],
      no: ['なし', '無', 'no', 'false', '0'],
      undetermined: ['未判定', '不明', '']
    },

    privacy: {
      // この名前を含む列は読み込み時に除外する（個人情報・不要な機密情報）
      deniedFieldPatterns: [
        'tenant', 'resident', 'applicant', 'guarantor', 'contact', 'email', 'mail', 'phone', 'tel',
        'user_name', 'username', 'person', 'owner_name', 'sharepoint', 'url', 'path',
        '入居者', '申込者', '契約者', '保証', '氏名', '担当者', '電話', 'メール', '連絡先'
      ],
      // 表示文字列から伏せる情報
      maskLabel: '［非表示］'
    }
  };
});
