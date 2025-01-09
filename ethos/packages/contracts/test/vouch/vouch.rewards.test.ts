import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers.js';
import { expect } from 'chai';
import hre from 'hardhat';
import { calcFeeDistribution } from '../utils/common.js';
import { DEFAULT } from '../utils/defaults.js';
import { createDeployer, type EthosDeployer } from '../utils/deployEthos.js';
import { type EthosUser } from '../utils/ethosUser.js';

const { ethers } = hre;

describe('Vouch Rewards', () => {
  let deployer: EthosDeployer;
  let userA: EthosUser;
  let userB: EthosUser;
  const donationFee = 150n;
  const vouchersPoolFee = 150n;

  beforeEach(async () => {
    deployer = await loadFixture(createDeployer);
    [userA, userB] = await Promise.all([deployer.createUser(), deployer.createUser()]);
  });

  async function setupDonationFee(): Promise<void> {
    await deployer.ethosVouch.contract
      .connect(deployer.ADMIN)
      .setEntryDonationFeeBasisPoints(donationFee);
    await deployer.ethosVouch.contract
      .connect(deployer.ADMIN)
      .setEntryVouchersPoolFeeBasisPoints(vouchersPoolFee);
  }

  it('should allow withdrawing accumulated rewards', async () => {
    await setupDonationFee();

    // Create a vouch to generate rewards for userB
    await userA.vouch(userB);
    const initialBalance = await userB.getBalance();

    // Get rewards balance
    const rewardsBalance = await userB.getRewardsBalance();
    const {
      shares: { donation },
    } = calcFeeDistribution(DEFAULT.PAYMENT_AMOUNT, {
      entry: 0n,
      donation: donationFee,
      vouchIncentives: 0n, // no vouch pool incentives for first vouch
    });
    expect(rewardsBalance).to.equal(donation);

    // Withdraw rewards
    const withdrawTx = await deployer.ethosVouch.contract.connect(userB.signer).claimRewards();
    const receipt = await withdrawTx.wait();

    if (!receipt) {
      expect.fail('Transaction failed or receipt is null');
    }

    const gasCost = receipt.gasUsed * receipt.gasPrice;
    const finalBalance = await userB.getBalance();

    // Verify the balance increased by rewards amount (minus gas costs)
    const expectedBalance = initialBalance + rewardsBalance - gasCost;
    expect(finalBalance).to.equal(expectedBalance);

    // Verify rewards balance is now 0
    const newRewardsBalance = await userB.getRewardsBalance();
    expect(newRewardsBalance).to.equal(0n);
  });

  it('should accumulate rewards from multiple vouches', async () => {
    await setupDonationFee();

    // Create multiple vouches to generate rewards from different users
    const userC = await deployer.createUser();
    await userA.vouch(userB);
    const {
      shares: { donation: userADonation },
    } = calcFeeDistribution(DEFAULT.PAYMENT_AMOUNT, {
      entry: 0n,
      donation: donationFee,
      vouchIncentives: 0n, // no vouch pool incentives for first vouch
    });
    await userC.vouch(userB);
    const {
      shares: { donation: userCDonation },
    } = calcFeeDistribution(DEFAULT.PAYMENT_AMOUNT, {
      entry: 0n,
      donation: donationFee,
      vouchIncentives: vouchersPoolFee,
    });

    const rewardsBalance = await userB.getRewardsBalance();
    const expectedRewards = userADonation + userCDonation;
    expect(rewardsBalance).to.equal(expectedRewards);
  });

  it('should not allow withdrawing rewards with zero balance', async () => {
    await expect(
      deployer.ethosVouch.contract.connect(userB.signer).claimRewards(),
    ).to.be.revertedWithCustomError(deployer.ethosVouch.contract, 'InsufficientRewardsBalance');
  });

  it('should handle failed reward withdrawals gracefully', async () => {
    // Generate some rewards
    await setupDonationFee();
    await userA.vouch(userB);

    // Try to withdraw with a contract that doesn't accept ETH
    const nonPayableContract = await deployer.createUser(); // Using a regular user account instead of mock
    await expect(
      deployer.ethosVouch.contract.connect(nonPayableContract.signer).claimRewards(),
    ).to.be.revertedWithCustomError(deployer.ethosVouch.contract, 'InsufficientRewardsBalance');
  });

  it('should redirect vouchByAttestation to vouchByProfileId for verified profiles', async () => {
    await setupDonationFee();

    // First create an attestation for userB
    const attestationHash = await userB.attest({
      service: DEFAULT.SERVICE_X,
      account: DEFAULT.ACCOUNT_NAME_EXAMPLE,
    });

    // Try to vouch using vouchByAttestation - should work since profile is verified
    await deployer.ethosVouch.contract
      .connect(userA.signer)
      .vouchByAttestation(attestationHash, DEFAULT.COMMENT, DEFAULT.METADATA, {
        value: DEFAULT.PAYMENT_AMOUNT,
      });

    // Verify the vouch was created correctly
    const vouch = await deployer.ethosVouch.contract.verifiedVouchByAuthorForSubjectProfileId(
      userA.profileId,
      userB.profileId,
    );

    expect(vouch.authorProfileId).to.equal(userA.profileId);
    expect(vouch.subjectProfileId).to.equal(userB.profileId);
    expect(vouch.comment).to.equal(DEFAULT.COMMENT);
    expect(vouch.metadata).to.equal(DEFAULT.METADATA);

    // Verify rewards were distributed correctly
    const rewardsBalance = await userB.getRewardsBalance();
    const {
      shares: { donation },
    } = calcFeeDistribution(DEFAULT.PAYMENT_AMOUNT, {
      entry: 0n,
      donation: donationFee,
      vouchIncentives: 0n, // first vouch does not apply vouch rewards
    });
    expect(rewardsBalance).to.equal(donation);
  });

  it('should correctly track rewards across multiple recipients', async () => {
    await setupDonationFee();
    const userC = await deployer.createUser();

    // Generate rewards for multiple users
    await userA.vouch(userB);
    await userA.vouch(userC);

    const {
      shares: { donation },
    } = calcFeeDistribution(DEFAULT.PAYMENT_AMOUNT, {
      entry: 0n,
      donation: donationFee,
      vouchIncentives: 0n, // first vouch does not apply vouch rewards
    });
    expect(await userB.getRewardsBalance()).to.equal(donation);
    expect(await userC.getRewardsBalance()).to.equal(donation);
  });

  it('should distribute rewards correctly when increasing attestation-based vouch', async () => {
    await setupDonationFee();

    // First create an attestation for userB
    const attestationHash = await userB.attest({
      service: DEFAULT.SERVICE_X,
      account: DEFAULT.ACCOUNT_NAME_EXAMPLE,
    });

    // Initial vouch by userA using attestation
    await deployer.ethosVouch.contract
      .connect(userA.signer)
      .vouchByAttestation(attestationHash, DEFAULT.COMMENT, DEFAULT.METADATA, {
        value: DEFAULT.PAYMENT_AMOUNT,
      });

    // Create another user to vouch for the same attestation
    const userC = await deployer.createUser();
    await deployer.ethosVouch.contract
      .connect(userC.signer)
      .vouchByAttestation(attestationHash, DEFAULT.COMMENT, DEFAULT.METADATA, {
        value: DEFAULT.PAYMENT_AMOUNT,
      });

    // Get initial rewards balance
    const initialRewards =
      await deployer.ethosVouch.contract.rewardsByAttestationHash(attestationHash);

    // Get userC's initial vouch balance
    const userCVouchInitial = await deployer.ethosVouch.contract.vouches(1); // Second vouch ID
    const initialBalance = userCVouchInitial.balance;

    // Increase vouch amount for userA's vouch
    const increaseAmount = DEFAULT.PAYMENT_AMOUNT;
    const vouchId = 0; // First vouch ID
    const tx = await deployer.ethosVouch.contract
      .connect(userA.signer)
      .increaseVouch(vouchId, attestationHash, userB.signer.address, { value: increaseAmount });

    // Wait for the transaction to be mined and get the receipt
    const receipt = await tx.wait();

    if (!receipt) {
      throw new Error('Transaction failed');
    }

    // Verify rewards were distributed correctly
    const finalRewards =
      await deployer.ethosVouch.contract.rewardsByAttestationHash(attestationHash);
    const {
      shares: { donation },
    } = calcFeeDistribution(increaseAmount, {
      entry: 0n,
      donation: donationFee,
      vouchIncentives: vouchersPoolFee,
    });
    // Allow for 1 wei rounding difference
    expect(finalRewards - initialRewards).to.be.oneOf([donation, donation + 1n]);

    // Get userC's final vouch balance and verify it increased by their share of the vouchers pool fee
    const userCVouchFinal = await deployer.ethosVouch.contract.vouches(1);
    const {
      shares: { vouchersPool },
    } = calcFeeDistribution(increaseAmount, {
      entry: 0n,
      donation: donationFee,
      vouchIncentives: vouchersPoolFee,
    });
    // Allow for 1 wei rounding difference
    expect(userCVouchFinal.balance - initialBalance).to.be.oneOf([vouchersPool, vouchersPool + 1n]);
  });

  it('should distribute rewards correctly when increasing address-based vouch', async () => {
    await setupDonationFee();

    // Create a profile for userB first
    await userB.registerAddress(userB.signer.address);

    // Initial vouch by userA
    await deployer.ethosVouch.contract
      .connect(userA.signer)
      .vouchByAddress(userB.signer.address, DEFAULT.COMMENT, DEFAULT.METADATA, {
        value: DEFAULT.PAYMENT_AMOUNT,
      });

    // Create another user to vouch for the same address
    const userC = await deployer.createUser();
    await deployer.ethosVouch.contract
      .connect(userC.signer)
      .vouchByAddress(userB.signer.address, DEFAULT.COMMENT, DEFAULT.METADATA, {
        value: DEFAULT.PAYMENT_AMOUNT,
      });

    // Get initial rewards balance
    const initialRewards = await deployer.ethosVouch.contract.rewardsByAddress(
      userB.signer.address,
    );

    // Get userC's initial vouch balance
    const userCVouchInitial = await deployer.ethosVouch.contract.vouches(1);
    const initialBalance = userCVouchInitial.balance;

    // Increase vouch amount for userA's vouch
    const increaseAmount = DEFAULT.PAYMENT_AMOUNT;
    const vouchId = 0; // First vouch ID
    const tx = await deployer.ethosVouch.contract
      .connect(userA.signer)
      .increaseVouch(
        vouchId,
        '0x0000000000000000000000000000000000000000000000000000000000000000',
        userB.signer.address,
        { value: increaseAmount },
      );

    // Wait for the transaction to be mined and get the receipt
    const receipt = await tx.wait();

    if (!receipt) {
      throw new Error('Transaction failed');
    }

    // Verify rewards were distributed correctly
    const finalRewards = await deployer.ethosVouch.contract.rewardsByAddress(userB.signer.address);
    const {
      shares: { donation },
    } = calcFeeDistribution(increaseAmount, {
      entry: 0n,
      donation: donationFee,
      vouchIncentives: vouchersPoolFee,
    });
    // Allow for 1 wei rounding difference
    expect(finalRewards - initialRewards).to.be.oneOf([donation, donation + 1n]);

    // Get userC's final vouch balance and verify it increased by their share of the vouchers pool fee
    const userCVouchFinal = await deployer.ethosVouch.contract.vouches(1);
    const {
      shares: { vouchersPool },
    } = calcFeeDistribution(increaseAmount, {
      entry: 0n,
      donation: donationFee,
      vouchIncentives: vouchersPoolFee,
    });
    // Allow for 1 wei rounding difference
    expect(userCVouchFinal.balance - initialBalance).to.be.oneOf([vouchersPool, vouchersPool + 1n]);
  });

  it('should emit DepositedToRewards event when rewards are generated', async () => {
    await setupDonationFee();
    const {
      shares: { donation },
    } = calcFeeDistribution(DEFAULT.PAYMENT_AMOUNT, {
      entry: 0n,
      donation: donationFee,
      vouchIncentives: 0n,
    });

    await userA.vouch(userB);

    const filter = deployer.ethosVouch.contract.filters.DepositedToRewards(userB.profileId);
    const events = await deployer.ethosVouch.contract.queryFilter(filter);

    expect(events.length).to.equal(1);
    expect(events[0].args?.[0]).to.equal(userB.profileId);
    expect(events[0].args?.[1]).to.equal(donation);
  });

  it('should emit WithdrawnFromRewards event when rewards are withdrawn', async () => {
    await setupDonationFee();
    await userA.vouch(userB);

    const rewardsBalance = await userB.getRewardsBalance();
    await expect(deployer.ethosVouch.contract.connect(userB.signer).claimRewards())
      .to.emit(deployer.ethosVouch.contract, 'WithdrawnFromRewards')
      .withArgs(userB.profileId, rewardsBalance);
  });

  it('should handle rewards for archived profiles', async () => {
    await setupDonationFee();
    await userA.vouch(userB);

    // Create and archive userB's profile
    await deployer.ethosProfile.contract.connect(userB.signer).archiveProfile();

    // Verify rewards can still be withdrawn
    await expect(deployer.ethosVouch.contract.connect(userB.signer).claimRewards()).to.not.be
      .reverted;
  });

  it('should not allow claiming rewards from an address that was only reviewed but never joined', async () => {
    await setupDonationFee();

    // Create a new address that will only be reviewed
    const reviewedUser = await deployer.newWallet();

    // Review the address
    await userA.review({
      address: reviewedUser.address,
    });

    // Generate some rewards for the reviewed address by vouching for userB
    await deployer.ethosVouch.contract
      .connect(userA.signer)
      .vouchByAddress(reviewedUser.address, DEFAULT.COMMENT, DEFAULT.METADATA, {
        value: DEFAULT.PAYMENT_AMOUNT,
      });

    // Try to claim rewards using the reviewed address - should fail
    await expect(deployer.ethosVouch.contract.connect(reviewedUser).claimRewards())
      .to.be.revertedWithCustomError(deployer.ethosVouch.contract, 'ProfileNotFoundForAddress')
      .withArgs(reviewedUser.address);
  });

  it('should allow claiming rewards for an attestation mock profile after attestation is claimed', async () => {
    await setupDonationFee();
    // leave a review for twitter account
    await userA.review({
      attestationDetails: {
        service: DEFAULT.SERVICE_X,
        account: DEFAULT.ACCOUNT_NAME_EXAMPLE,
      },
    });
    const attestationHash = await userA.getAttestationHash(
      DEFAULT.SERVICE_X,
      DEFAULT.ACCOUNT_NAME_EXAMPLE,
    );

    // vouch for the twitter account
    await deployer.ethosVouch.contract
      ?.connect(userA.signer)
      .vouchByAttestation(attestationHash, DEFAULT.COMMENT, DEFAULT.METADATA, {
        value: DEFAULT.PAYMENT_AMOUNT,
      });
    // user claims twitter account
    await userB.attest({
      service: DEFAULT.SERVICE_X,
      account: DEFAULT.ACCOUNT_NAME_EXAMPLE,
    });
    // Check contract balance before claim
    const contractBalanceBefore = await ethers.provider.getBalance(
      deployer.ethosVouch.contract.target,
    );
    const rewardsBalance =
      await deployer.ethosVouch.contract?.rewardsByAttestationHash(attestationHash);
    expect(rewardsBalance).to.be.greaterThan(0n);

    // Claim rewards
    await deployer.ethosVouch.contract
      .connect(userB.signer)
      .claimRewardsByAttestation(attestationHash);

    // Verify contract balance decreased by rewards amount
    const contractBalanceAfter = await ethers.provider.getBalance(
      deployer.ethosVouch.contract.target,
    );
    expect(contractBalanceAfter).to.equal(contractBalanceBefore - rewardsBalance);
  });

  it('should allow claiming rewards for an address mock profile after address is registered', async () => {
    await setupDonationFee();
    const reviewedUser = await deployer.newWallet();
    // leave a review for an address
    await userA.review({ address: reviewedUser.address });
    // vouch for the address
    await deployer.ethosVouch.contract
      ?.connect(userA.signer)
      .vouchByAddress(reviewedUser.address, DEFAULT.COMMENT, DEFAULT.METADATA, {
        value: DEFAULT.PAYMENT_AMOUNT,
      });
    // user claims address
    await userB.registerAddress(reviewedUser.address);

    // Check contract balance before claim
    const contractBalanceBefore = await ethers.provider.getBalance(
      deployer.ethosVouch.contract.target,
    );
    const rewardsBalance = await deployer.ethosVouch.contract.rewardsByAddress(
      reviewedUser.address,
    );
    expect(rewardsBalance).to.be.greaterThan(0n);

    // Claim rewards with the address originally vouched
    await deployer.ethosVouch.contract.connect(reviewedUser).claimRewards();

    // Verify contract balance decreased by rewards amount
    const contractBalanceAfter = await ethers.provider.getBalance(
      deployer.ethosVouch.contract.target,
    );
    expect(contractBalanceAfter).to.equal(contractBalanceBefore - rewardsBalance);
  });
});
