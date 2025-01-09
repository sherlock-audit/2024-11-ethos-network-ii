import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers.js';
import { expect } from 'chai';

import { type EthosVouch } from '../../typechain-types/index.js';
import { VOUCH_PARAMS } from '../utils/defaults.js';
import { createDeployer, type EthosDeployer } from '../utils/deployEthos.js';
import { type EthosUser } from '../utils/ethosUser.js';

describe('EthosVouch Slashing', () => {
  let deployer: EthosDeployer;
  let userA: EthosUser;
  let userB: EthosUser;
  let slasher: EthosUser;
  let ethosVouch: EthosVouch;

  beforeEach(async () => {
    deployer = await loadFixture(createDeployer);
    [userA, userB, slasher] = await Promise.all([
      deployer.createUser(),
      deployer.createUser(),
      deployer.createUser(),
    ]);

    if (!deployer.ethosVouch.contract) {
      throw new Error('EthosVouch contract not found');
    }
    ethosVouch = deployer.ethosVouch.contract;

    // Set up slasher role via ContractAddressManager
    await deployer.contractAddressManager.contract
      .connect(deployer.OWNER)
      .updateContractAddressesForNames([slasher.signer.address], ['SLASHER']);

    // Set up initial vouch
    await userA.vouch(userB);
  });

  it('should allow slasher to slash vouches', async () => {
    const slashPercentage = 1000n; // 10%
    const initialBalance = await ethosVouch.verifiedVouchByAuthorForSubjectProfileId(
      userA.profileId,
      userB.profileId,
    );

    await ethosVouch.connect(slasher.signer).slash(userA.profileId, slashPercentage);

    const finalBalance = await ethosVouch.verifiedVouchByAuthorForSubjectProfileId(
      userA.profileId,
      userB.profileId,
    );

    expect(finalBalance.balance).to.equal((initialBalance.balance * 90n) / 100n);
  });

  it('should not allow non-slasher to slash vouches', async () => {
    const slashPercentage = 1000n; // 10%

    await expect(
      ethosVouch.connect(userA.signer).slash(userB.profileId, slashPercentage),
    ).to.be.revertedWithCustomError(ethosVouch, 'NotSlasher');
  });

  it('should not allow slashing with percentage above maximum', async () => {
    const maxSlashPercentage = await ethosVouch.MAX_SLASH_PERCENTAGE();
    const tooHighPercentage = maxSlashPercentage + 1n;

    await expect(
      ethosVouch.connect(slasher.signer).slash(userA.profileId, tooHighPercentage),
    ).to.be.revertedWithCustomError(ethosVouch, 'InvalidSlashPercentage');
  });

  it('should slash all vouches from an author', async () => {
    // Create multiple vouches from userA
    const userC = await deployer.createUser();
    const userD = await deployer.createUser();
    await userA.vouch(userC);
    await userA.vouch(userD);

    const slashPercentage = 1000n; // 10%
    await ethosVouch.connect(slasher.signer).slash(userA.profileId, slashPercentage);

    // Check all vouches are slashed
    const subjects = [userB, userC, userD];

    for (const subject of subjects) {
      const vouch = await ethosVouch.verifiedVouchByAuthorForSubjectProfileId(
        userA.profileId,
        subject.profileId,
      );
      expect(vouch.balance).to.equal((VOUCH_PARAMS.paymentAmount * 90n) / 100n);
    }
  });

  it('should emit VouchSlashed event with correct parameters', async () => {
    const slashPercentage = 1000n; // 10%

    await expect(ethosVouch.connect(slasher.signer).slash(userA.profileId, slashPercentage))
      .to.emit(ethosVouch, 'Slashed')
      .withArgs(userA.profileId, slashPercentage, (VOUCH_PARAMS.paymentAmount * 10n) / 100n);
  });

  it('should handle multiple slashes correctly', async () => {
    const initialBalance = await ethosVouch.verifiedVouchByAuthorForSubjectProfileId(
      userA.profileId,
      userB.profileId,
    );

    // First slash 10%
    await ethosVouch.connect(slasher.signer).slash(userA.profileId, 1000n);

    // Second slash 10% of remaining
    await ethosVouch.connect(slasher.signer).slash(userA.profileId, 1000n);

    const finalBalance = await ethosVouch.verifiedVouchByAuthorForSubjectProfileId(
      userA.profileId,
      userB.profileId,
    );

    expect(finalBalance.balance).to.equal((initialBalance.balance * 81n) / 100n);
  });

  it('should handle very small slash percentages correctly', async () => {
    const slashPercentage = 1n; // 0.01%
    const initialBalance = await ethosVouch.verifiedVouchByAuthorForSubjectProfileId(
      userA.profileId,
      userB.profileId,
    );

    await ethosVouch.connect(slasher.signer).slash(userA.profileId, slashPercentage);

    const finalBalance = await ethosVouch.verifiedVouchByAuthorForSubjectProfileId(
      userA.profileId,
      userB.profileId,
    );

    // Should reduce balance by 0.01%
    expect(finalBalance.balance).to.equal((initialBalance.balance * 9999n) / 10000n);
  });

  describe('Frozen Authors', () => {
    let vouchId: bigint;

    beforeEach(async () => {
      const vouch = await ethosVouch.verifiedVouchByAuthorForSubjectProfileId(
        userA.profileId,
        userB.profileId,
      );
      vouchId = vouch.vouchId;
    });

    it('should prevent withdrawals when author is frozen', async () => {
      await ethosVouch.connect(slasher.signer).freeze(userA.profileId);

      await expect(ethosVouch.connect(userA.signer).unvouch(vouchId))
        .to.be.revertedWithCustomError(ethosVouch, 'PendingSlash')
        .withArgs(vouchId, userA.profileId);
    });

    it('should allow withdrawals after unfreezing', async () => {
      await ethosVouch.connect(slasher.signer).freeze(userA.profileId);
      await ethosVouch.connect(slasher.signer).unfreeze(userA.profileId);

      await expect(ethosVouch.connect(userA.signer).unvouch(vouchId))
        .to.emit(ethosVouch, 'Unvouched')
        .withArgs(vouchId, userA.profileId, userB.profileId, VOUCH_PARAMS.paymentAmount);
    });

    it('should allow withdrawals for non-frozen authors', async () => {
      await ethosVouch.connect(slasher.signer).freeze(userA.profileId);

      // userB should still be able to unvouch even though userA is frozen
      const userBVouch = await userB.vouch(userA);
      await expect(ethosVouch.connect(userB.signer).unvouch(userBVouch.vouchId))
        .to.emit(ethosVouch, 'Unvouched')
        .withArgs(userBVouch.vouchId, userB.profileId, userA.profileId, VOUCH_PARAMS.paymentAmount);
    });

    it('should maintain frozen status after slashing', async () => {
      await ethosVouch.connect(slasher.signer).freeze(userA.profileId);
      await ethosVouch.connect(slasher.signer).slash(userA.profileId, 1000n); // 10% slash

      await expect(ethosVouch.connect(userA.signer).unvouch(vouchId))
        .to.be.revertedWithCustomError(ethosVouch, 'PendingSlash')
        .withArgs(vouchId, userA.profileId);
    });

    it('should emit Frozen event when freezing and unfreezing', async () => {
      await expect(ethosVouch.connect(slasher.signer).freeze(userA.profileId))
        .to.emit(ethosVouch, 'Frozen')
        .withArgs(userA.profileId, true);

      await expect(ethosVouch.connect(slasher.signer).unfreeze(userA.profileId))
        .to.emit(ethosVouch, 'Frozen')
        .withArgs(userA.profileId, false);
    });
  });
});
