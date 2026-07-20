import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../../../', import.meta.url))
let vite
let displayUtils

before(async () => {
  vite = await createServer({
    root,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  displayUtils = await vite.ssrLoadModule('/src/features/products/productDisplayUtils.ts')
})

after(async () => {
  await vite?.close()
})

function channel(valueCents, options = {}) {
  return {
    status: 'verified',
    valueCents,
    evidenceIds: [`evidence-${valueCents}`],
    ...options,
  }
}

function unavailable(reason = 'no-explicit-evidence') {
  return { status: 'unavailable', valueCents: null, evidenceIds: [], reason }
}

function skuWithChannels(channels, extra = {}) {
  return {
    skuId: 'sku-1',
    name: '测试 SKU',
    price: 150,
    normalPrice: 150,
    resolutionStatus: 'verified',
    priceResolution: { status: 'verified', channels },
    ...extra,
  }
}

test('verified new-customer gift is visible to normal, gift and 88VIP views', () => {
  const sku = skuWithChannels({
    normal: channel(10900),
    gift: channel(9400, { label: '新客礼金价', formula: '普通价 109.00 - 新客礼金 15.00 = 新客礼金价 94.00' }),
    vip88: unavailable(),
  }, { giftPrice: 1 })

  for (const accountType of ['normal', 'gift', 'vip88']) {
    const benefit = displayUtils.accountBenefitForSku(sku, accountType)
    assert.equal(benefit.available, true, accountType)
    assert.equal(benefit.price, 94, accountType)
    assert.equal(benefit.label, '新客礼金价', accountType)
    assert.equal(displayUtils.verifiedPriceChannelsForAccount(accountType).includes('gift'), true, accountType)
  }
})

test('specific gift labels stay specific in the SKU price row', () => {
  assert.equal(displayUtils.displayPriceLabel('新客礼金价'), '新客礼金价')
  assert.equal(displayUtils.displayPriceLabel('首单礼金价'), '首单礼金价')
  assert.equal(displayUtils.displayPriceLabel('店铺礼金'), '礼金价')
})

test('code 1 gift remains visible only to 88VIP even when the channel is marked verified', () => {
  const sku = skuWithChannels({
    normal: channel(13900),
    gift: channel(9900, { label: '首单礼金价' }),
  })
  sku.priceResolution.promotions = [{ code: '1', kind: 'gift', label: '首单礼金' }]

  assert.equal(displayUtils.accountBenefitForSku(sku, 'normal').available, false)
  assert.equal(displayUtils.accountBenefitForSku(sku, 'gift').available, false)
  assert.equal(displayUtils.accountBenefitForSku(sku, 'vip88').price, 99)
  assert.equal(displayUtils.lowestVerifiedPriceForSku(sku, 'normal'), 139)
  assert.equal(displayUtils.lowestVerifiedPriceForSku(sku, 'gift'), 139)
  assert.equal(displayUtils.lowestVerifiedPriceForSku(sku, 'vip88'), 99)
})

test('88VIP prefers its verified channel while other views exclude it from lowest price', () => {
  const sku = skuWithChannels({
    normal: channel(15000),
    gift: channel(14000, { label: '新客礼金价' }),
    vip88: channel(13000),
  })

  assert.equal(displayUtils.accountBenefitForSku(sku, 'normal').label, '新客礼金价')
  assert.equal(displayUtils.accountBenefitForSku(sku, 'gift').label, '新客礼金价')
  assert.equal(displayUtils.accountBenefitForSku(sku, 'vip88').label, '88VIP价')
  assert.equal(displayUtils.lowestVerifiedPriceForSku(sku, 'normal'), 140)
  assert.equal(displayUtils.lowestVerifiedPriceForSku(sku, 'gift'), 140)
  assert.equal(displayUtils.lowestVerifiedPriceForSku(sku, 'vip88'), 130)
  assert.equal(displayUtils.verifiedPriceChannelsForAccount('normal').includes('vip88'), false)
})

test('raw gift fields cannot bypass an unavailable resolver channel', () => {
  const sku = skuWithChannels({
    normal: channel(15000),
    gift: unavailable('different-account-promotion'),
    vip88: unavailable('different-account-promotion'),
  }, {
    giftPrice: 1,
    giftStatus: 'available',
    vipPrice: 2,
    vipStatus: 'available',
    priceLayers: [
      { label: '首单礼金价', value: 1, kind: 'price' },
      { label: '88VIP价', value: 2, kind: 'price' },
    ],
  })

  assert.equal(displayUtils.giftBenefitForSku(sku).available, false)
  assert.equal(displayUtils.giftBenefitForSku(sku).price, null)
  assert.equal(displayUtils.vipBenefitForSku(sku).available, false)
  assert.equal(displayUtils.lowestVerifiedPriceForSku(sku, 'normal'), 150)
  assert.equal(displayUtils.lowestVerifiedPriceForSku(sku, 'vip88'), 150)
  assert.equal(displayUtils.priceLayersForSku(sku, { accountType: 'normal' }).some((layer) => /礼金|88VIP/.test(layer.label)), false)
})

test('account views use their own resolver result instead of another account raw fields', () => {
  const sku = skuWithChannels({ normal: channel(10900), gift: unavailable() }, {
    accountPrices: [
      {
        sessionId: 'normal-session',
        accountName: '普通账号',
        accountType: 'normal',
        price: 109,
        giftPrice: 94,
        resolutionStatus: 'verified',
        priceResolution: { status: 'verified', channels: { normal: channel(10900), gift: unavailable('different-account-promotion') } },
      },
      {
        sessionId: 'vip-session',
        accountName: '88VIP账号',
        accountType: 'vip88',
        price: 94,
        giftPrice: 94,
        resolutionStatus: 'verified',
        priceResolution: { status: 'verified', channels: { normal: channel(10900), gift: channel(9400, { label: '新客礼金价' }) } },
      },
    ],
  })

  const normalView = displayUtils.skuForAccountView(sku, 'normal-session', 'normal')
  const vipView = displayUtils.skuForAccountView(sku, 'vip-session', 'vip88')
  assert.equal(displayUtils.giftBenefitForSku(normalView).available, false)
  assert.equal(displayUtils.giftBenefitForSku(vipView).price, 94)
})
